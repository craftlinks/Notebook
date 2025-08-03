const std = @import("std");
const clap = @cImport({
    @cInclude("clap.h");
    @cInclude("factory/plugin-factory.h");
});

const pluginDescriptor = clap.clap_plugin_descriptor_t{
    .clap_version = .{
        .major = clap.CLAP_VERSION_MAJOR,
        .minor = clap.CLAP_VERSION_MINOR,
        .revision = clap.CLAP_VERSION_REVISION,
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
        clap.CLAP_PLUGIN_FEATURE_INSTRUMENT,
        clap.CLAP_PLUGIN_FEATURE_SYNTHESIZER,
        clap.CLAP_PLUGIN_FEATURE_STEREO,
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
    plugin: clap.clap_plugin_t,
    host: [*c]const clap.clap_host_t,
    sample_rate: f32,
    voices: std.ArrayList(Voice),
};

fn pluginInit(p: [*c]const clap.clap_plugin_t) callconv(.C) bool {
    const plugin: *MyPlugin = @as(*MyPlugin, @ptrCast(@alignCast(p.*.plugin_data.?)));
    _ = plugin;
    return true;
}

fn pluginDestroy(p: [*c]const clap.clap_plugin_t) callconv(.C) void {
    const plugin: *MyPlugin = @as(*MyPlugin, @ptrCast(@alignCast(p.*.plugin_data.?)));
    plugin.voices.deinit();
    std.heap.c_allocator.destroy(plugin);
}

fn pluginActivate(p: [*c]const clap.clap_plugin_t, sample_rate: f64, min_frames: u32, max_frames: u32) callconv(.C) bool {
    const plugin = @as(*MyPlugin, @ptrCast(@alignCast(p.*.plugin_data.?)));
    _ = min_frames;
    _ = max_frames;
    plugin.sample_rate = @floatCast(sample_rate);
    return true;
}

fn pluginDeactivate(p: [*c]const clap.clap_plugin_t) callconv(.C) void {
    _ = p;
}

fn pluginStartProcessing(p: [*c]const clap.clap_plugin_t) callconv(.C) bool {
    _ = p;
    return true;
}

fn pluginStopProcessing(p: [*c]const clap.clap_plugin_t) callconv(.C) void {
    _ = p;
}

fn pluginReset(p: [*c]const clap.clap_plugin_t) callconv(.C) void {
    const plugin = @as(*MyPlugin, @ptrCast(@alignCast(p.*.plugin_data.?)));
    plugin.voices.clearRetainingCapacity();
}

fn pluginProcess(p: [*c]const clap.clap_plugin_t, process: [*c]const clap.clap_process_t) callconv(.C) clap.clap_process_status {
    const plugin = @as(*MyPlugin, @ptrCast(@alignCast(p.*.plugin_data.?)));

    std.debug.assert(process.*.audio_outputs_count == 1);
    std.debug.assert(process.*.audio_inputs_count == 0);

    const frame_count = process.*.frames_count;
    const in_events = process.*.in_events;
    const input_event_count: u32 = if (in_events) |events| events.*.size.?(events) else 0;
    var event_index: u32 = 0;
    var next_event_frame: u32 = if (input_event_count > 0) 0 else frame_count;

    var i: u32 = 0;
    while (i < frame_count) {
        while (event_index < input_event_count and next_event_frame == i) {
            const event = if (in_events) |events| events.*.get.?(events, event_index) else null;

            if (event) |e| {
                if (e.*.time != i) {
                    next_event_frame = e.*.time;
                    break;
                }
            }

            pluginProcessEvent(plugin, event);
            event_index += 1;

            if (event_index == input_event_count) {
                next_event_frame = frame_count;
                break;
            } else {
                const next_event = if (in_events) |events| events.*.get.?(events, event_index) else null;
                if (next_event) |e| {
                    next_event_frame = e.*.time;
                }
            }
        }

        if (i < next_event_frame) {
            const output = process.*.audio_outputs.?[0];
            const outputL = output.data32[0][0..frame_count];
            const outputR = output.data32[1][0..frame_count];
            pluginRenderAudio(plugin, i, next_event_frame, outputL, outputR);
        }

        i = next_event_frame;
    }

    var voice_index: usize = 0;
    while (voice_index < plugin.voices.items.len) {
        const voice = plugin.voices.items[voice_index];
        if (!voice.held) {
            var event = clap.clap_event_note_t{
                .header = .{
                    .size = @sizeOf(clap.clap_event_note_t),
                    .time = 0,
                    .space_id = clap.CLAP_CORE_EVENT_SPACE_ID,
                    .type = clap.CLAP_EVENT_NOTE_END,
                    .flags = 0,
                },
                .port_index = 0,
                .key = voice.key,
                .channel = voice.channel,
                .note_id = voice.note_id,
                .velocity = 0,
            };

            if (process.*.out_events) |out_events| {
                _ = out_events.*.try_push.?(out_events, &event.header);
            }
            _ = plugin.voices.orderedRemove(voice_index);
        } else {
            voice_index += 1;
        }
    }

    return clap.CLAP_PROCESS_CONTINUE;
}

fn pluginProcessEvent(plugin: *MyPlugin, event: [*c]const clap.clap_event_header_t) void {
    if (event.*.space_id != clap.CLAP_CORE_EVENT_SPACE_ID) {
        return;
    }

    switch (event.*.type) {
        clap.CLAP_EVENT_NOTE_ON, clap.CLAP_EVENT_NOTE_OFF, clap.CLAP_EVENT_NOTE_CHOKE => {
            const noteEvent: [*c]const clap.clap_event_note_t = @ptrCast(@alignCast(event));

            var i: usize = 0;
            while (i < plugin.voices.items.len) {
                const voice = &plugin.voices.items[i];
                const key_matches = (noteEvent.*.key == -1 or voice.key == noteEvent.*.key);
                const note_id_matches = (noteEvent.*.note_id == -1 or voice.note_id == noteEvent.*.note_id);
                const channel_matches = (noteEvent.*.channel == -1 or voice.channel == noteEvent.*.channel);

                if (key_matches and note_id_matches and channel_matches) {
                    if (event.*.type == clap.CLAP_EVENT_NOTE_CHOKE) {
                        _ = plugin.voices.orderedRemove(i);
                        continue;
                    } else {
                        plugin.voices.items[i].held = false;
                    }
                }
                i += 1;
            }

            if (event.*.type == clap.CLAP_EVENT_NOTE_ON) {
                const voice = Voice{
                    .held = true,
                    .note_id = noteEvent.*.note_id,
                    .channel = noteEvent.*.channel,
                    .key = noteEvent.*.key,
                    .phase = 0.0,
                };
                plugin.voices.append(voice) catch {};
            }
        },
        else => {},
    }
}

fn pluginRenderAudio(plugin: *MyPlugin, start: u32, end: u32, outputL: []f32, outputR: []f32) void {
    var i = start;
    while (i < end) : (i += 1) {
        var sum: f32 = 0.0;

        for (plugin.voices.items) |*voice| {
            if (!voice.held) continue;
            sum += std.math.sin(voice.phase * 2.0 * std.math.pi) * 0.2;
            const freq = 440.0 * std.math.exp2((@as(f32, @floatFromInt(voice.key)) - 57.0) / 12.0);
            voice.phase += freq / plugin.sample_rate;
            voice.phase -= @floor(voice.phase);
        }

        outputL[i] = sum;
        outputR[i] = sum;
    }
}

const extensionNotePorts = clap.clap_plugin_note_ports_t{
    .count = struct {
        fn count(p: [*c]const clap.clap_plugin_t, is_input: bool) callconv(.C) u32 {
            _ = p;
            return if (is_input) 1 else 0;
        }
    }.count,
    .get = struct {
        fn get(p: [*c]const clap.clap_plugin_t, index: u32, is_input: bool, info: [*c]clap.clap_note_port_info_t) callconv(.C) bool {
            _ = p;
            if (is_input and index == 0) {
                info.* = .{
                    .id = 0,
                    .supported_dialects = clap.CLAP_NOTE_DIALECT_CLAP | clap.CLAP_NOTE_DIALECT_MIDI,
                    .preferred_dialect = clap.CLAP_NOTE_DIALECT_CLAP,
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

const extensionAudioPorts = clap.clap_plugin_audio_ports_t{
    .count = struct {
        fn count(p: [*c]const clap.clap_plugin_t, is_input: bool) callconv(.C) u32 {
            _ = p;
            return if (is_input) 0 else 1;
        }
    }.count,
    .get = struct {
        fn get(p: [*c]const clap.clap_plugin_t, index: u32, is_input: bool, info: [*c]clap.clap_audio_port_info_t) callconv(.C) bool {
            _ = p;
            if (!is_input and index == 0) {
                info.* = .{
                    .id = 0,
                    .name = undefined,
                    .flags = clap.CLAP_AUDIO_PORT_IS_MAIN,
                    .channel_count = 2,
                    .port_type = &clap.CLAP_PORT_STEREO,
                    .in_place_pair = clap.CLAP_INVALID_ID,
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

fn pluginGetExtension(p: [*c]const clap.clap_plugin_t, id: [*c]const u8) callconv(.C) ?*const anyopaque {
    _ = p;
    if (std.mem.eql(u8, std.mem.span(id), &clap.CLAP_EXT_NOTE_PORTS)) {
        return &extensionNotePorts;
    }
    if (std.mem.eql(u8, std.mem.span(id), &clap.CLAP_EXT_AUDIO_PORTS)) {
        return &extensionAudioPorts;
    }
    return null;
}

fn pluginOnMainThread(p: [*c]const clap.clap_plugin_t) callconv(.C) void {
    _ = p;
}

const plugin_class = clap.clap_plugin_t{
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

const pluginFactory = clap.clap_plugin_factory_t{
    .get_plugin_count = struct {
        fn get_plugin_count(factory: [*c]const clap.clap_plugin_factory_t) callconv(.C) u32 {
            _ = factory;
            return 1;
        }
    }.get_plugin_count,
    .get_plugin_descriptor = struct {
        fn get_plugin_descriptor(factory: [*c]const clap.clap_plugin_factory_t, index: u32) callconv(.C) [*c]const clap.clap_plugin_descriptor_t {
            _ = factory;
            return if (index == 0) &pluginDescriptor else null;
        }
    }.get_plugin_descriptor,
    .create_plugin = struct {
        fn create_plugin(factory: [*c]const clap.clap_plugin_factory_t, host: [*c]const clap.clap_host_t, plugin_id: [*c]const u8) callconv(.C) [*c]const clap.clap_plugin_t {
            _ = factory;
            if (!clap.clap_version_is_compatible(host.*.clap_version) or !std.mem.eql(u8, std.mem.span(plugin_id), std.mem.span(pluginDescriptor.id))) {
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

export const clap_entry: clap.clap_plugin_entry_t = .{
    .clap_version = .{
        .major = clap.CLAP_VERSION_MAJOR,
        .minor = clap.CLAP_VERSION_MINOR,
        .revision = clap.CLAP_VERSION_REVISION,
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
            return if (std.mem.eql(u8, std.mem.span(factoryID), &clap.CLAP_PLUGIN_FACTORY_ID)) &pluginFactory else null;
        }
    }.get_factory,
};
