const std = @import("std");
const cl = @cImport({
    @cInclude("clap.h");
    @cInclude("factory/plugin-factory.h");
});

const Mutex = std.Thread.Mutex;

fn floatClamp01(x: f32) f32 {
    return std.math.clamp(x, 0.0, 1.0);
}

// Parameters.
const P_VOLUME: u32 = 0;
const P_COUNT: u32 = 1;

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
    parameter_offsets: [P_COUNT]f32,
};

const MyPlugin = struct {
    plugin: cl.clap_plugin_t,
    host: [*c]const cl.clap_host_t,
    sample_rate: f32,
    voices: std.ArrayList(Voice),
    sync_parameters_mutex: Mutex,
    params: [P_COUNT]f32,
    main_params: [P_COUNT]f32,
    changed_params: [P_COUNT]bool,
    main_changed_params: [P_COUNT]bool,
};

fn toMyPlugin(p: [*c]const cl.clap_plugin_t) *MyPlugin {
    return @as(*MyPlugin, @ptrCast(@alignCast(p.*.plugin_data.?)));
}

fn pluginInit(p: [*c]const cl.clap_plugin_t) callconv(.C) bool {
    const plugin: *MyPlugin = toMyPlugin(p);

    for (plugin.params, 0..) |_, i| {
        var information: cl.clap_param_info_t = undefined;
        _ = extensionParams.get_info.?(p, @intCast(i), &information);
        plugin.main_params[i] = @floatCast(information.default_value);
        plugin.params[i] = @floatCast(information.default_value);
    }

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

    pluginSyncMainToAudio(plugin, process.*.out_events);

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
                    .parameter_offsets = [_]f32{0} ** P_COUNT,
                };
                plugin.voices.append(new_voice) catch {
                    // Allocation failure: silently drop the note.
                };
            }
        },
        // For the CLAP_EVENT_PARAM_VALUE, we store the value into the parameters array (since we are on the audio thread),
        // and mark the corresponding changed boolean, so that the main thread knows the audio thread wants to update the value.
        // We make sure that the operation is done under lock of the syncParameters mutex, since we are modifying the arrays.
        cl.CLAP_EVENT_PARAM_VALUE => {
            const valueEvent: [*c]const cl.clap_event_param_value_t = @ptrCast(@alignCast(event));
            const i = @as(u32, @intCast(valueEvent.*.param_id));
            plugin.sync_parameters_mutex.lock();
            plugin.params[i] = @floatCast(valueEvent.*.value);
            plugin.changed_params[i] = true;
            plugin.sync_parameters_mutex.unlock();
        },
        // For the CLAP_EVENT_PARAM_MOD, we iterate through the voices, and for any that match the query, we update the parameter offset.
        // Since this is non-destructive modulation, the main thread doesn't need to know about this, since it won't be using the values for serialization.
        cl.CLAP_EVENT_PARAM_MOD => {
            const modEvent: [*c]const cl.clap_event_param_mod_t = @ptrCast(@alignCast(event));

            for (plugin.voices.items) |*voice| {
                if ((modEvent.*.key == -1 or voice.*.key == modEvent.*.key) and (modEvent.*.note_id == -1 or voice.*.note_id == modEvent.*.note_id) and (modEvent.*.channel == -1 or voice.*.channel == modEvent.*.channel)) {
                    voice.*.parameter_offsets[modEvent.*.param_id] = @floatCast(modEvent.*.amount);
                    break;
                }
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

            const volume = floatClamp01(plugin.params[P_VOLUME]) + voice.parameter_offsets[P_VOLUME];

            // Convert MIDI key to frequency (A4 = 440 Hz, key 57)
            const freq = 440.0 * std.math.exp2((@as(f32, @floatFromInt(voice.key)) - 57.0) / 12.0);

            // Generate a sine wave sample for this voice
            // phase is a 0..1 value representing position in the waveform cycle
            const sample = std.math.sin(voice.phase * 2.0 * std.math.pi) * 0.2 * volume;
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

// This tells the host about the properties of our parameters (.count, .get_info),
// gives it a way to query the current value of parameters (.get_value),
// gives it a way to transform values to and from text (.value_to_text, .text_to_value),
// and also provides a mechanism for parameter synchronization when the plugin isn't processing audio (.flush).

const extensionParams = cl.clap_plugin_params_t{
    .count = struct {
        fn count(p: [*c]const cl.clap_plugin_t) callconv(.C) u32 {
            _ = p;
            return P_COUNT;
        }
    }.count,
    .get_info = struct {
        fn get_info(p: [*c]const cl.clap_plugin_t, index: u32, information: [*c]cl.clap_param_info_t) callconv(.C) bool {
            _ = p;
            if (index == P_VOLUME) {
                information.* = .{
                    .id = index,
                    .flags = cl.CLAP_PARAM_IS_AUTOMATABLE | cl.CLAP_PARAM_IS_MODULATABLE | cl.CLAP_PARAM_IS_MODULATABLE_PER_NOTE_ID,
                    .min_value = 0.0,
                    .max_value = 1.0,
                    .default_value = 0.5,
                    .name = undefined,
                };
                const name = "Volume";
                @memcpy(information.*.name[0..name.len], name);
                information.*.name[name.len] = 0;
                return true;
            }
            return false;
        }
    }.get_info,
    .get_value = struct {
        fn get_value(p: [*c]const cl.clap_plugin_t, id: u32, value: [*c]f64) callconv(.C) bool {
            const plugin = toMyPlugin(p);
            if (id >= P_COUNT) return false;

            // get_value is called on the main thread, but should return the value of the parameter according to the audio thread,
            // since the value on the audio thread is the one that host communicates with us via CLAP_EVENT_PARAM_VALUE events.
            // Since we're accessing the opposite thread's arrays, we must acquire the syncParameters mutex.
            // And although we need to check the mainChanged array, we mustn't actually modify the parameters array,
            // since that can only be done on the audio thread. Don't worry -- it'll pick up the changes eventually.

            plugin.sync_parameters_mutex.lock();
            defer plugin.sync_parameters_mutex.unlock();
            value.* = if (plugin.main_changed_params[id]) plugin.main_params[id] else plugin.params[id];
            return true;
        }
    }.get_value,
    .value_to_text = struct {
        fn value_to_text(p: [*c]const cl.clap_plugin_t, id: u32, value: f64, display: [*c]u8, size: u32) callconv(.C) bool {
            _ = p;
            if (id >= P_COUNT) return false;
            _ = std.fmt.bufPrint(display[0..size], "{d:.2}", .{value}) catch return false;
            return true;
        }
    }.value_to_text,
    .text_to_value = struct {
        fn text_to_value(p: [*c]const cl.clap_plugin_t, id: u32, display: [*c]const u8, value: [*c]f64) callconv(.C) bool {
            _ = p;
            if (id >= P_COUNT) return false;
            value.* = std.fmt.parseFloat(f64, std.mem.span(display)) catch return false;
            return true;
        }
    }.text_to_value,

    .flush = struct {
        fn flush(p: [*c]const cl.clap_plugin_t, in: [*c]const cl.clap_input_events_t, out: [*c]const cl.clap_output_events_t) callconv(.C) void {
            const plugin = toMyPlugin(p);
            const event_count = in.*.size.?(in);

            // For parameters that have been modified by the main thread, send CLAP_EVENT_PARAM_VALUE events to the host.
            pluginSyncMainToAudio(plugin, out);

            // Forward any parameter-value events received from the host (on the
            // main thread) to the audio thread mirror. We avoid re-using
            // `pluginProcessEvent` here because that routine is designed for the
            // audio thread and would incorrectly flag `changed_params` in the
            // wrong direction.
            for (0..event_count) |event_index| {
                const hdr = in.*.get.?(in, @intCast(event_index));

                if (hdr.*.space_id != cl.CLAP_CORE_EVENT_SPACE_ID) continue;
                switch (hdr.*.type) {
                    cl.CLAP_EVENT_PARAM_VALUE => {
                        const ev: [*c]const cl.clap_event_param_value_t = @ptrCast(@alignCast(hdr));
                        const pid: usize = @intCast(ev.*.param_id);
                        plugin.sync_parameters_mutex.lock();
                        plugin.main_params[pid] = @floatCast(ev.*.value);
                        plugin.main_changed_params[pid] = true;
                        plugin.sync_parameters_mutex.unlock();
                    },
                    else => {},
                }
            }
        }
    }.flush,
};

// This lets our plugin save and restore its state.
// We assume that the stream accessor functions won't result in short reads or writes, but this is not guaranteed;
// in a production plugin, you should modify these implementation to handle short reads and writes.
const extensionState = cl.clap_plugin_state_t{
    .save = struct {
        fn save(p: [*c]const cl.clap_plugin_t, stream: [*c]const cl.clap_ostream_t) callconv(.C) bool {
            const plugin = toMyPlugin(p);

            // Synchronize any changes from the audio thread (that is, parameter values sent to us by the host)
            // before we save the state of the plugin.
            _ = pluginSyncAudioToMain(plugin);

            return @sizeOf(f32) * P_COUNT == stream.*.write.?(stream, &plugin.main_params, @sizeOf(f32) * P_COUNT);
        }
    }.save,
    .load = struct {
        fn load(p: [*c]const cl.clap_plugin_t, stream: [*c]const cl.clap_istream_t) callconv(.C) bool {
            const plugin = toMyPlugin(p);

            // Since we're modifying a parameter array, we need to acquire the syncParameters mutex.
            plugin.sync_parameters_mutex.lock();
            defer plugin.sync_parameters_mutex.unlock();
            const success = @sizeOf(f32) * P_COUNT == stream.*.read.?(stream, &plugin.main_params, @sizeOf(f32) * P_COUNT);
            // Make sure that the audio thread will pick up upon the modified parameters next time pluginClass.process is called.
            for (0..P_COUNT) |i| {
                plugin.main_changed_params[i] = true;
            }
            return success;
        }
    }.load,
};

fn pluginGetExtension(p: [*c]const cl.clap_plugin_t, id: [*c]const u8) callconv(.C) ?*const anyopaque {
    _ = p;
    if (std.mem.eql(u8, std.mem.span(id), &cl.CLAP_EXT_NOTE_PORTS)) {
        return &extensionNotePorts;
    }
    if (std.mem.eql(u8, std.mem.span(id), &cl.CLAP_EXT_AUDIO_PORTS)) {
        return &extensionAudioPorts;
    }
    if (std.mem.eql(u8, std.mem.span(id), &cl.CLAP_EXT_PARAMS)) {
        return &extensionParams;
    }
    if (std.mem.eql(u8, std.mem.span(id), &cl.CLAP_EXT_STATE)) {
        return &extensionState;
    }
    return null;
}

fn pluginOnMainThread(p: [*c]const cl.clap_plugin_t) callconv(.C) void {
    _ = p;
}

/// Synchronises parameter changes from the main (UI) thread to the real-time
/// audio thread.
///
/// This function is called from the audio thread once per processing block.
/// It copies any parameters that the UI has marked as “dirty” into the
/// audio-side parameter array and then notifies the host about the new value
/// by pushing a `CLAP_EVENT_PARAM_VALUE` event into the output queue.
///
/// Thread-safety:
///   - `plugin.changed_params` and `plugin.main_params` are protected by
///     `plugin.sync_parameters_mutex`.
///   - `out_events` is provided by the host and is assumed to be valid for the
///     duration of the call.
///
/// Arguments:
///   plugin – pointer to the plugin instance.
///   out    – host-supplied event queue where parameter-change events are sent.
fn pluginSyncMainToAudio(plugin: *MyPlugin, out: [*c]const cl.clap_output_events_t) void {
    // Lock the critical section so the main thread cannot modify parameters
    // while we are reading them.
    plugin.sync_parameters_mutex.lock();
    defer plugin.sync_parameters_mutex.unlock();

    // Iterate over every parameter slot looking for updates flagged by the
    // *main* thread.  These are stored in `main_changed_params`, leaving
    // `changed_params` exclusively for the opposite direction (audio ➜ main).
    for (plugin.main_changed_params, 0..) |changed, param_id| {
        if (changed) {
            // Copy the new value from the main thread into the audio thread.
            plugin.params[param_id] = plugin.main_params[param_id];
            plugin.main_changed_params[param_id] = false; // Mark as processed.

            // Build a CLAP parameter-value event that the host will forward
            // to any interested parties (automation lanes, UI, etc.).
            const event = cl.clap_event_param_value_t{
                .header = .{
                    .size = @sizeOf(cl.clap_event_param_value_t),
                    .time = 0, // Apply at the start of this processing block.
                    .space_id = cl.CLAP_CORE_EVENT_SPACE_ID,
                    .type = cl.CLAP_EVENT_PARAM_VALUE,
                    .flags = 0,
                },
                .param_id = @intCast(param_id),
                .cookie = null,
                .note_id = -1, // Not associated with a specific note.
                .port_index = -1,
                .channel = -1,
                .key = -1,
                .value = plugin.params[param_id],
            };

            // Push the event into the host’s output queue.
            // The host guarantees the queue is valid for the duration of the
            // process() call, so no additional lifetime checks are needed.
            _ = out.*.try_push.?(out, &event.header);
        }
    }
}

/// Copies any parameter changes that occurred on the audio thread
/// into the main-thread mirror (`main_params`).
///
/// This function is called from the main thread to pick up changes that the audio thread
/// has flagged via `changed_params`.
///
/// Thread-safety:
///   - `plugin.changed_params` and `plugin.main_params` are protected by
///     `plugin.sync_parameters_mutex`.
///
/// Returns:
///   `true`  – at least one parameter was updated.
///   `false` – no parameters changed since the last call.
fn pluginSyncAudioToMain(plugin: *MyPlugin) bool {
    var anyChanged = false;

    // Enter the critical section so we can safely read the flags
    // that the audio thread may still be writing.
    plugin.sync_parameters_mutex.lock();
    defer plugin.sync_parameters_mutex.unlock();

    // Walk through every parameter slot.
    for (plugin.changed_params, 0..) |changed, param_id| {
        if (changed) {
            // Copy the latest value from the audio thread.
            plugin.main_params[param_id] = plugin.params[param_id];

            // Clear the flag so the audio thread can set it again later.
            plugin.changed_params[param_id] = false;

            anyChanged = true;
        }
    }

    return anyChanged;
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
                .sync_parameters_mutex = Mutex{},
                .params = [_]f32{0} ** P_COUNT,
                .main_params = [_]f32{0} ** P_COUNT,
                .changed_params = [_]bool{false} ** P_COUNT,
                .main_changed_params = [_]bool{false} ** P_COUNT,
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
