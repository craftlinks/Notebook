const std = @import("std");

pub fn build(b: *std.Build) void {

    const target = b.standardTargetOptions(.{});

    const optimize = b.standardOptimizeOption(.{});

    const lib_mod = b.createModule(.{
        .root_source_file = b.path("src/clap.zig"),
        .target = target,
        .optimize = optimize,
    });

    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "clap.clap",
        .root_module = lib_mod,
    });
    
    lib.addIncludePath(b.path("cclap"));
    lib.linkLibC();
    
    b.installArtifact(lib);
}
