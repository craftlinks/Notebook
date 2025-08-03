const std = @import("std");
const cl = @cImport({
    @cInclude("clap.h");
    @cInclude("factory/plugin-factory.h");
});

const pluginDescriptor = cl.clap_plugin_descriptor_t{
    .clap_version = .{
        .major = cl.CLAP_VERSION_MAJOR,
        .minor = cl.CLAP_VERSION_MINOR,
        .revision = cl.CLAP_VERSION_REVISION,
    },
    .id = "com.github.craftlinks.clap",
    .name = "ZClap",
    .vendor = "craftlife",
    .url = "https://github.com/craftlinks/Notebook/tree/main/zclap",
    .manual_url = "",
    .support_url = "",
    .version = "0.0.1",
    .description = "A simple clap plugin written in Zig",
    .features = &[_][*c]const u8{
        cl.CLAP_PLUGIN_FEATURE_INSTRUMENT,
        cl.CLAP_PLUGIN_FEATURE_SYNTHESIZER,
        cl.CLAP_PLUGIN_FEATURE_STEREO,
        null,
    },
};

const Voice = struct {
    held: bool,
    note_id: i32,
    channel: i16,
    key: i16,
    phase: f32,
};

const MyPlugin = struct {
    plugin: cl.clap_plugin_t,
    host: [*c]const cl.clap_host_t,
    sample_rate: f32,
    voices: std.ArrayList(Voice),
};

fn toMyPlugin(p: [*c]const cl.clap_plugin_t) *MyPlugin {
    return @as(*MyPlugin, @ptrCast(@alignCast(p.*.plugin_data.?)));
}

fn pluginInit(p: [*c]const cl.clap_plugin_t) callconv(.C) bool {
    const plugin: *MyPlugin = toMyPlugin(p);
    _ = plugin;
    return true;
}

fn pluginDestroy(p: [*c]const cl.clap_plugin_t) callconv(.C) void {
    const plugin: *MyPlugin = toMyPlugin(p);
    plugin.voices.deinit();
    std.heap.c_allocator.destroy(plugin);
}

fn pluginActivate(p: [*c]const cl.clap_plugin_t, sample_rate: f64, min_frames: u32, max_frames: u32) callconv(.C) bool {
    const plugin = toMyPlugin(p);
    _ = min_frames;
    _ = max_frames;
    plugin.sample_rate = @floatCast(sample_rate);
    return true;
}

fn pluginDeactivate(p: [*c]const cl.clap_plugin_t) callconv(.C) void {
    _ = p;
}

fn pluginStartProcessing(p: [*c]const cl.clap_plugin_t) callconv(.C) bool {
    _ = p;
    return true;
}

fn pluginStopProcessing(p: [*c]const cl.clap_plugin_t) callconv(.C) void {
    _ = p;
}

fn pluginReset(p: [*c]const cl.clap_plugin_t) callconv(.C) void {
    const plugin = toMyPlugin(p);
    plugin.voices.clearRetainingCapacity();
}

/// Main audio-processing callback.
/// The host calls this every processing block to:
/// 1. Consume incoming MIDI/parameter events.
/// 2. Render audio for the requested number of frames.
/// 3. Generate outgoing events (e.g. NOTE_END when voices finish).
///
/// A *frame* is one multi-channel sample: for a stereo output that is
/// exactly one left sample plus one right sample.  The host requests
/// `frames_count` consecutive frames on every call; the plugin must fill
/// every frame in the provided buffers.
///
/// Returns one of the CLAP_PROCESS_* status codes.
fn pluginProcess(
    p: [*c]const cl.clap_plugin_t,
    process: [*c]const cl.clap_process_t,
) callconv(.C) cl.clap_process_status {
    const plugin = toMyPlugin(p);

    // We only support a single stereo output bus and no audio inputs.
    std.debug.assert(process.*.audio_outputs_count == 1);
    std.debug.assert(process.*.audio_inputs_count == 0);

    const frame_count = process.*.frames_count;

    // ------------------------------------------------------------------
    // 1. Prepare event stream
    // ------------------------------------------------------------------
    const in_events = process.*.in_events;
    const input_event_count: u32 = if (in_events) |ev| ev.*.size.?(ev) else 0;

    // Index of the next event to process.
    var event_index: u32 = 0;
    // Frame index at which the next event should be handled.
    // If no events exist, we render the entire block in one go.
    var next_event_frame: u32 = if (input_event_count > 0) 0 else frame_count;

    // ------------------------------------------------------------------
    // 2. Process events and render audio in sub-blocks
    // ------------------------------------------------------------------
    var frame_cursor: u32 = 0;
    while (frame_cursor < frame_count) {
        // Handle all events scheduled for the current frame_cursor.
        while (event_index < input_event_count and next_event_frame == frame_cursor) {
            const event = if (in_events) |ev| ev.*.get.?(ev, event_index) else null;

            // Defensive check: if the event's time is in the future, stop
            // processing events for this frame and schedule it later.
            if (event) |e| {
                if (e.*.time != frame_cursor) {
                    next_event_frame = e.*.time;
                    break;
                }
            }

            pluginProcessEvent(plugin, event);
            event_index += 1;

            // Determine the frame of the next event (if any).
            if (event_index == input_event_count) {
                next_event_frame = frame_count; // No more events.
            } else {
                const next_event = if (in_events) |ev| ev.*.get.?(ev, event_index) else null;
                next_event_frame = if (next_event) |e| e.*.time else frame_count;
            }
        }

        // Render audio for the sub-block [frame_cursor, next_event_frame).
        if (frame_cursor < next_event_frame) {
            const output = process.*.audio_outputs.?[0];
            const outputL = output.data32[0][0..frame_count];
            const outputR = output.data32[1][0..frame_count];
            pluginRenderAudio(plugin, frame_cursor, next_event_frame, outputL, outputR);
        }

        frame_cursor = next_event_frame;
    }

    // ------------------------------------------------------------------
    // 3. Clean up finished voices and notify the host
    // ------------------------------------------------------------------
    var voice_index: usize = 0;
    while (voice_index < plugin.voices.items.len) {
        const voice = plugin.voices.items[voice_index];

        // If the voice is no longer held, send NOTE_END and remove it.
        if (!voice.held) {
            const note_end_event = cl.clap_event_note_t{
                .header = .{
                    .size = @sizeOf(cl.clap_event_note_t),
                    .time = 0, // Deliver at the start of the next block.
                    .space_id = cl.CLAP_CORE_EVENT_SPACE_ID,
                    .type = cl.CLAP_EVENT_NOTE_END,
                    .flags = 0,
                },
                .port_index = 0,
                .key = voice.key,
                .channel = voice.channel,
                .note_id = voice.note_id,
                .velocity = 0,
            };

            // Push the event to the host if an output event queue exists.
            if (process.*.out_events) |out_events| {
                _ = out_events.*.try_push.?(out_events, &note_end_event.header);
            }

            _ = plugin.voices.orderedRemove(voice_index);
            // Do not increment voice_index; the next voice shifted down.
        } else {
            voice_index += 1;
        }
    }

    return cl.CLAP_PROCESS_CONTINUE;
}

/// Processes a single CLAP event targeted at the plugin.
///
/// Only events in the CLAP core event space are handled.  Currently supported:
///   • CLAP_EVENT_NOTE_ON   – starts a new voice
///   • CLAP_EVENT_NOTE_OFF  – releases any matching voices
///   • CLAP_EVENT_NOTE_CHOKE – immediately removes any matching voices
///
/// Matching logic:
///   • A field value of ‑1 in the event acts as a wildcard (matches any value).
///   • Otherwise the event’s key, note_id, and channel must all match the voice.
fn pluginProcessEvent(plugin: *MyPlugin, event: [*c]const cl.clap_event_header_t) void {
    // Ignore events from unknown or non-core event spaces.
    if (event.*.space_id != cl.CLAP_CORE_EVENT_SPACE_ID) {
        return;
    }

    switch (event.*.type) {
        cl.CLAP_EVENT_NOTE_ON,
        cl.CLAP_EVENT_NOTE_OFF,
        cl.CLAP_EVENT_NOTE_CHOKE,
        => {
            // Safely reinterpret the generic header as a note event.
            const noteEvent: [*c]const cl.clap_event_note_t = @ptrCast(@alignCast(event));

            // Scan all active voices for matches.
            var i: usize = 0;
            while (i < plugin.voices.items.len) {
                const voice = &plugin.voices.items[i];

                // Wildcard (-1) matches any value; otherwise exact match required.
                const key_matches = (noteEvent.*.key == -1 or voice.key == noteEvent.*.key);
                const id_matches = (noteEvent.*.note_id == -1 or voice.note_id == noteEvent.*.note_id);
                const chan_matches = (noteEvent.*.channel == -1 or voice.channel == noteEvent.*.channel);

                if (key_matches and id_matches and chan_matches) {
                    switch (event.*.type) {
                        // CHOKE: remove the voice immediately.
                        cl.CLAP_EVENT_NOTE_CHOKE => {
                            _ = plugin.voices.orderedRemove(i);
                            continue; // Do not increment `i`; next voice shifted down.
                        },
                        // NOTE_OFF: mark the voice as released so it can decay naturally.
                        else => {
                            plugin.voices.items[i].held = false;
                        },
                    }
                }
                i += 1;
            }

            // NOTE_ON: create a new voice for the incoming note.
            if (event.*.type == cl.CLAP_EVENT_NOTE_ON) {
                const new_voice = Voice{
                    .held = true,
                    .note_id = noteEvent.*.note_id,
                    .channel = noteEvent.*.channel,
                    .key = noteEvent.*.key,
                    .phase = 0.0, // Start sine oscillator at zero phase.
                };
                plugin.voices.append(new_voice) catch {
                    // Allocation failure: silently drop the note.
                };
            }
        },
        else => {}, // Ignore all other event types.
    }
}

fn pluginRenderAudio(plugin: *MyPlugin, start: u32, end: u32, outputL: []f32, outputR: []f32) void {
    var i = start;
    while (i < end) : (i += 1) {
        var sum: f32 = 0.0;

        for (plugin.voices.items) |*voice| {
            if (!voice.held) continue;

            // Convert MIDI key to frequency (A4 = 440 Hz, key 57)
            const freq = 440.0 * std.math.exp2((@as(f32, @floatFromInt(voice.key)) - 57.0) / 12.0);

            // Generate a sine wave sample for this voice
            // phase is a 0..1 value representing position in the waveform cycle
            const sample = std.math.sin(voice.phase * 2.0 * std.math.pi) * 0.2;
            sum += sample;

            // Advance phase based on frequency and sample rate
            // This calculates how much of the waveform cycle to advance per sample
            const phase_increment = freq / plugin.sample_rate;
            voice.phase += phase_increment;

            // Wrap phase back to 0..1 range to prevent floating point overflow
            // and maintain continuous waveform
            voice.phase -= @floor(voice.phase);
        }

        outputL[i] = sum;
        outputR[i] = sum;
    }
}

const extensionNotePorts = cl.clap_plugin_note_ports_t{
    .count = struct {
        fn count(p: [*c]const cl.clap_plugin_t, is_input: bool) callconv(.C) u32 {
            _ = p;
            return if (is_input) 1 else 0;
        }
    }.count,
    .get = struct {
        fn get(p: [*c]const cl.clap_plugin_t, index: u32, is_input: bool, info: [*c]cl.clap_note_port_info_t) callconv(.C) bool {
            _ = p;
            if (is_input and index == 0) {
                info.* = .{
                    .id = 0,
                    .supported_dialects = cl.CLAP_NOTE_DIALECT_CLAP | cl.CLAP_NOTE_DIALECT_MIDI,
                    .preferred_dialect = cl.CLAP_NOTE_DIALECT_CLAP,
                    .name = undefined,
                };
                const name = "Note In";
                @memcpy(info.*.name[0..name.len], name);
                info.*.name[name.len] = 0;
                return true;
            }
            return false;
        }
    }.get,
};

const extensionAudioPorts = cl.clap_plugin_audio_ports_t{
    .count = struct {
        fn count(p: [*c]const cl.clap_plugin_t, is_input: bool) callconv(.C) u32 {
            _ = p;
            return if (is_input) 0 else 1;
        }
    }.count,
    .get = struct {
        fn get(p: [*c]const cl.clap_plugin_t, index: u32, is_input: bool, info: [*c]cl.clap_audio_port_info_t) callconv(.C) bool {
            _ = p;
            if (!is_input and index == 0) {
                info.* = .{
                    .id = 0,
                    .name = undefined,
                    .flags = cl.CLAP_AUDIO_PORT_IS_MAIN,
                    .channel_count = 2,
                    .port_type = &cl.CLAP_PORT_STEREO,
                    .in_place_pair = cl.CLAP_INVALID_ID,
                };
                const name = "Audio Out";
                @memcpy(info.*.name[0..name.len], name);
                info.*.name[name.len] = 0;
                return true;
            }
            return false;
        }
    }.get,
};

fn pluginGetExtension(p: [*c]const cl.clap_plugin_t, id: [*c]const u8) callconv(.C) ?*const anyopaque {
    _ = p;
    if (std.mem.eql(u8, std.mem.span(id), &cl.CLAP_EXT_NOTE_PORTS)) {
        return &extensionNotePorts;
    }
    if (std.mem.eql(u8, std.mem.span(id), &cl.CLAP_EXT_AUDIO_PORTS)) {
        return &extensionAudioPorts;
    }
    return null;
}

fn pluginOnMainThread(p: [*c]const cl.clap_plugin_t) callconv(.C) void {
    _ = p;
}

const plugin_class = cl.clap_plugin_t{
    .desc = &pluginDescriptor,
    .plugin_data = null,
    .init = pluginInit,
    .destroy = pluginDestroy,
    .activate = pluginActivate,
    .deactivate = pluginDeactivate,
    .start_processing = pluginStartProcessing,
    .stop_processing = pluginStopProcessing,
    .reset = pluginReset,
    .process = pluginProcess,
    .get_extension = pluginGetExtension,
    .on_main_thread = pluginOnMainThread,
};

const pluginFactory = cl.clap_plugin_factory_t{
    .get_plugin_count = struct {
        fn get_plugin_count(factory: [*c]const cl.clap_plugin_factory_t) callconv(.C) u32 {
            _ = factory;
            return 1;
        }
    }.get_plugin_count,
    .get_plugin_descriptor = struct {
        fn get_plugin_descriptor(factory: [*c]const cl.clap_plugin_factory_t, index: u32) callconv(.C) [*c]const cl.clap_plugin_descriptor_t {
            _ = factory;
            return if (index == 0) &pluginDescriptor else null;
        }
    }.get_plugin_descriptor,
    .create_plugin = struct {
        fn create_plugin(factory: [*c]const cl.clap_plugin_factory_t, host: [*c]const cl.clap_host_t, plugin_id: [*c]const u8) callconv(.C) [*c]const cl.clap_plugin_t {
            _ = factory;
            if (!cl.clap_version_is_compatible(host.*.clap_version) or !std.mem.eql(u8, std.mem.span(plugin_id), std.mem.span(pluginDescriptor.id))) {
                return null;
            }

            const plugin = std.heap.c_allocator.create(MyPlugin) catch return null;

            plugin.* = .{
                .plugin = plugin_class,
                .host = host,
                .sample_rate = 0,
                .voices = std.ArrayList(Voice).init(std.heap.c_allocator),
            };

            plugin.plugin.plugin_data = plugin;

            return &plugin.plugin;
        }
    }.create_plugin,
};

export const clap_entry: cl.clap_plugin_entry_t = .{
    .clap_version = .{
        .major = cl.CLAP_VERSION_MAJOR,
        .minor = cl.CLAP_VERSION_MINOR,
        .revision = cl.CLAP_VERSION_REVISION,
    },

    .init = struct {
        fn init(path: [*c]const u8) callconv(.C) bool {
            _ = path;
            return true;
        }
    }.init,

    .deinit = struct {
        fn deinit() callconv(.C) void {}
    }.deinit,

    .get_factory = struct {
        fn get_factory(factoryID: [*c]const u8) callconv(.C) ?*const anyopaque {
            return if (std.mem.eql(u8, std.mem.span(factoryID), &cl.CLAP_PLUGIN_FACTORY_ID)) &pluginFactory else null;
        }
    }.get_factory,
};
