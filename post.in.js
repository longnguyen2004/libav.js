/*
 * Copyright (C) 2019 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

var fileCallbacks = {
    open: function(stream) {
        if (!(stream.flags & 1)) {
            // Opened in read mode, which can't work
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
    },

    close: function() {},

    read: function() {
        throw new FS.ErrnoError(ERRNO_CODES.EIO);
    },

    write: function(stream, buffer, offset, length, position) {
        if (!Module.onwrite)
            throw new FS.ErrnoError(ERRNO_CODES.EIO);
        Module.onwrite(stream.node.name, position, buffer.subarray(offset, offset + length));
        return length;
    },

    llseek: function(stream, offset, whence) {
        if (whence === 2)
            throw new FS.ErrnoError(ERRNO_CODES.EIO);
        else if (whence === 1)
            offset += stream.position;
        return offset;
    }
};

@FUNCS

var writerDev = FS.makedev(44, 0);
FS.registerDevice(writerDev, fileCallbacks);

Module.readFile = FS.readFile.bind(FS);
Module.writeFile = FS.writeFile.bind(FS);
Module.unlink = FS.unlink.bind(FS);
Module.mkdev = FS.mkdev.bind(FS);
Module.mkwriterdev = function(loc, mode) {
    return FS.mkdev(loc, mode?mode:0777, writerDev);
};

/* Metafunction to initialize an encoder with all the bells and whistles
 * Returns [AVCodec, AVCodecContext, AVFrame, AVPacket, frame_size] */
var ff_init_encoder = Module.ff_init_encoder = function(name, ctxProps, time_base_num, time_base_den) {
    var codec = avcodec_find_encoder_by_name(name);
    if (codec === 0)
        throw new Error("Codec not found");

    var c = avcodec_alloc_context3(codec);
    if (c === 0)
        throw new Error("Could not allocate audio codec context");

    for (var prop in ctxProps)
        this["AVCodecContext_" + prop + "_si"](c, ctxProps[prop]);
    AVCodecContext_time_base_s(c, time_base_num, time_base_den);

    var ret = avcodec_open2(c, codec, 0);
    if (ret < 0)
        throw new Error("Could not open codec (" + ret + ")");

    var frame = av_frame_alloc();
    if (frame === 0)
        throw new Error("Could not allocate frame");
    var pkt = av_packet_alloc();
    if (pkt === 0)
        throw new Error("Could not allocate packet");

    var frame_size = AVCodecContext_frame_size(c);

    AVFrame_nb_samples_s(frame, frame_size);
    AVFrame_format_s(frame, ctxProps.sample_fmt);
    AVFrame_channel_layout_s(frame, ctxProps.channel_layout);

    if (av_frame_get_buffer(frame, 0) < 0)
        throw new Error("Could not allocate audio data buffers");

    return [codec, c, frame, pkt, frame_size];
};

/* Metafunction to initialize a decoder with all the bells and whistles.
 * Similar to ff_init_encoder but doesn't need to initialize the frame.
 * Returns [AVCodec, AVCodecContext, AVPacket, AVFrame] */
var ff_init_decoder = Module.ff_init_decoder = function(name) {
    var codec;
    if (typeof name === "string")
        codec = avcodec_find_decoder_by_name(name);
    else
        codec = avcodec_find_decoder(name);
    if (codec === 0)
        throw new Error("Codec not found");

    var c = avcodec_alloc_context3(codec);
    if (c === 0)
        throw new Error("Could not allocate audio codec context");

    var ret = avcodec_open2(c, codec, 0);
    if (ret < 0)
        throw new Error("Could not open codec (" + ret + ")");;

    var pkt = av_packet_alloc();
    if (pkt === 0)
        throw new Error("Could not allocate packet");

    var frame = av_frame_alloc();
    if (frame === 0)
        throw new Error("Could not allocate frame");

    return [codec, c, pkt, frame];
};

/* Free everything allocated by ff_init_encoder */
var ff_free_encoder = Module.ff_free_encoder = function(c, frame, pkt) {
    av_frame_free_js(frame);
    av_packet_free_js(pkt);
    avcodec_free_context_js(c);
};

/* Free everything allocated by ff_init_decoder */
var ff_free_decoder = Module.ff_free_decoder = function(c, pkt, frame) {
    ff_free_encoder(c, frame, pkt);
};

/* Encode many frames at once, done at this level to avoid message passing */
var ff_encode_multi = Module.ff_encode_multi = function(ctx, frame, pkt, inFrames, fin) {
    var outPackets = [];

    function handleFrame(inFrame) {
        if (inFrame !== null)
            ff_copyin_frame(frame, inFrame);

        var ret = avcodec_send_frame(ctx, inFrame?frame:0);
        if (ret < 0)
            throw new Error("Error sending the frame to the encoder");

        while (true) {
            ret = avcodec_receive_packet(ctx, pkt);
            if (ret === -11 /* EAGAIN */ || ret === -0x20464f45 /* AVERROR_EOF */)
                return;
            else if (ret < 0)
                throw new Error("Error encoding audio frame");

            var outPacket = ff_copyout_packet(pkt);
            outPacket.data = outPacket.data.slice(0);
            outPackets.push(outPacket);
        }
    }

    inFrames.forEach(handleFrame);

    if (fin)
        handleFrame(null);

    return outPackets;
};

/* Decode many packets at once, done at this level to avoid message passing */
var ff_decode_multi = Module.ff_decode_multi = function(ctx, pkt, frame, inPackets, fin) {
    var outFrames = [];

    function handlePacket(inPacket) {
        if (inPacket !== null) {
            if (av_packet_make_writable(pkt) < 0)
                throw new Error("Failed to make packet writable");
            ff_copyin_packet(pkt, inPacket);
        } else {
            av_packet_unref(pkt);
        }

        if (avcodec_send_packet(ctx, pkt) < 0)
            throw new Error("Error submitting the packet to the decoder");
        av_packet_unref(pkt);

        while (true) {
            var ret = avcodec_receive_frame(ctx, frame);
            if (ret === -11 /* EAGAIN */ || ret === -0x20464f45 /* AVERROR_EOF */)
                return;
            else if (ret < 0)
                throw new Error("Error decoding audio frame");

            var outFrame = ff_copyout_frame(frame);
            outFrame.data = outFrame.data.slice(0);
            outFrames.push(outFrame);
        }
    }

    inPackets.forEach(handlePacket);

    if (fin)
        handlePacket(null);

    return outFrames;
};

/* Set the content of a packet. Necessary because we tend to strip packets of their content. */
var ff_set_packet = Module.ff_set_packet = function(pkt, data) {
    var size = AVPacket_size(pkt);
    if (size < data.length) {
        var ret = av_grow_packet(pkt, data.length - size);
        if (ret < 0)
            throw new Error("Error growing packet: " + ret);
    } else if (size > data.length)
        av_shrink_packet(pkt, data.length);
    var ptr = AVPacket_data(pkt);
    Module.HEAPU8.set(data, ptr);
};

/* Initialize a muxer format, format context and some number of streams */
var ff_init_muxer = Module.ff_init_muxer = function(opts, streamCtxs) {
    var oformat = opts.oformat ? opts.oformat : 0;
    var format_name = opts.format_name ? opts.format_name : null;
    var filename = opts.filename ? opts.filename : null;
    var oc = avformat_alloc_output_context2_js(oformat, format_name, filename);
    if (oc === 0)
        throw new Error("Failed to allocate output context");
    var fmt = AVFormatContext_oformat(oc);
    var sts = [];
    streamCtxs.forEach(function(ctx) {
        var st = avformat_new_stream(oc, 0);
        if (st === 0)
            throw new Error("Could not allocate stream");
        var codecpar = AVStream_codecpar(st);
        if (avcodec_parameters_from_context(codecpar, ctx[0]) < 0)
            throw new Error("Could not copy the stream parameters");
        AVStream_time_base_s(st, ctx[1], ctx[2]);
    });

    // Set up the device if requested
    if (opts.device)
        FS.mkdev(opts.filename, 0777, writerDev);

    // Open the actual file if requested
    var pb = null;
    if (opts.open) {
        pb = avio_open2_js(opts.filename, 2 /* AVIO_FLAG_WRITE */, 0, 0);
        if (pb === 0)
            throw new Error("Could not open file");
        AVFormatContext_pb_s(oc, pb);
    }

    return [oc, fmt, pb, sts];
};

/* Free up a muxer format and/or file */
var ff_free_muxer = Module.ff_free_muxer = function(oc, pb) {
    avformat_free_context(oc);
    if (pb)
        avio_close(pb);
};

/* Initialize a demuxer from a file, format context, and get the list of codecs/types */
var ff_init_demuxer_file = Module.ff_init_demuxer_file = function(filename) {
    var fmt_ctx = avformat_open_input_js(filename, null, null);
    if (fmt_ctx === 0)
        throw new Error("Could not open source file");
    var nb_streams = AVFormatContext_nb_streams(fmt_ctx);
    var streams = [];
    for (var i = 0; i < nb_streams; i++) {
        var inStream = AVFormatContext_streams_a(fmt_ctx, i);
        var outStream = {};
        var codecpar = AVStream_codecpar(inStream);
        outStream.index = i;
        outStream.codec_type = AVCodecParameters_codec_type(codecpar);
        outStream.codec_id = AVCodecParameters_codec_id(codecpar);
        streams.push(outStream);
    }
    return [fmt_ctx, streams];
}

/* Write many packets at once, done at this level to avoid message passing */
var ff_write_multi = Module.ff_write_multi = function(oc, pkt, inPackets) {
    inPackets.forEach(function(inPacket) {
        if (av_packet_make_writable(pkt) < 0)
            throw new Error();
        ff_copyin_packet(pkt, inPacket);
        av_interleaved_write_frame(oc, pkt);
        av_packet_unref(pkt);
    });
    av_packet_unref(pkt);
};

/* Read many packets at once, done at this level to avoid message passing */
var ff_read_multi = Module.ff_read_multi = function(fmt_ctx, pkt, limit) {
    var sz = 0;
    var outPackets = [];

    while (true) {
        var ret = av_read_frame(fmt_ctx, pkt);
        if (ret < 0)
            return [ret, outPackets];

        var packet = ff_copyout_packet(pkt);
        outPackets.push(packet);
        sz += packet.data.length;
        if (limit && sz >= limit)
            return [-11 /* EAGAIN */, outPackets];
    }
};

/* Initialize a filter graph. No equivalent free since you just need to free
 * the graph itself, and everything under it will be freed automatically. */
var ff_init_filter_graph = Module.ff_init_filter_graph = function(filters_descr, channel_layout, sample_fmt, sample_rate, frame_size) {
    var abuffersrc, abuffersink, filter_graph, src_ctx, sink_ctx, outputs, inputs, int32s, int64s;
    var instr, outstr;

    // FIXME: This has so many allocations, it should have a try-finally to clean up

    abuffersrc = avfilter_get_by_name("abuffer");
    if (abuffersrc === 0)
        throw new Error("Failed to load abuffer filter");

    abuffersink = avfilter_get_by_name("abuffersink");
    if (abuffersink === 0)
        throw new Error("Failed to load abuffersink filter");

    outputs = avfilter_inout_alloc();
    if (outputs === 0)
        throw new Error("Failed to allocate outputs");

    inputs = avfilter_inout_alloc();
    if (inputs === 0)
        throw new Error("Failed to allocate inputs");

    filter_graph = avfilter_graph_alloc();
    if (filter_graph === 0)
        throw new Error("Failed to allocate filter graph");

    // Now create our input and output filters
    src_ctx = avfilter_graph_create_filter_js(abuffersrc, "in",
        "time_base=1/" + sample_rate + ":sample_rate=" + sample_rate +
        ":sample_fmt=" + sample_fmt + ":channel_layout=" + channel_layout,
        null, filter_graph);
    if (src_ctx === 0)
        throw new Error("Cannot create audio buffer source");

    sink_ctx = avfilter_graph_create_filter_js(abuffersink, "out", null, null,
        filter_graph);
    if (sink_ctx === 0)
        throw new Error("Cannot create audio buffer sink");

    // Allocate space to transfer our options
    int32s = ff_malloc_int32_list([sample_fmt, -1, sample_rate, -1]);
    int64s = ff_malloc_int64_list([channel_layout, -1]);
    instr = av_strdup("in");
    outstr = av_strdup("out");
    if (int32s === 0 || int64s === 0 || instr === 0 || outstr === 0)
        throw new Error("Failed to transfer parameters");

    if (
        av_opt_set_int_list_js(sink_ctx, "sample_fmts", 4, int32s, -1, 1 /* AV_OPT_SEARCH_CHILDREN */) < 0 ||
        av_opt_set_int_list_js(sink_ctx, "channel_layouts", 8, int64s, -1, 1) < 0 ||
        av_opt_set_int_list_js(sink_ctx, "sample_rates", 4, int32s + 8, -1, 1) < 0)
    {
        throw new Error("Failed to set filter parameters");
    }

    AVFilterInOut_name_s(outputs, instr);
    AVFilterInOut_filter_ctx_s(outputs, src_ctx);
    AVFilterInOut_pad_idx_s(outputs, 0);
    AVFilterInOut_next_s(outputs, 0);
    AVFilterInOut_name_s(inputs, outstr);
    AVFilterInOut_filter_ctx_s(inputs, sink_ctx);
    AVFilterInOut_pad_idx_s(inputs, 0);
    AVFilterInOut_next_s(inputs, 0);

    // Parse it
    if (avfilter_graph_parse(filter_graph, filters_descr, inputs, outputs, 0) < 0)
        throw new Error("Failed to initialize filters");

    // Set the output frame size
    av_buffersink_set_frame_size(sink_ctx, frame_size);

    // Configure it
    if (avfilter_graph_config(filter_graph, 0) < 0)
        throw new Error("Failed to configure filter graph");

    // Free our leftovers
    free(int32s);
    free(int64s);

    // And finally, return the critical parts
    return [filter_graph, src_ctx, sink_ctx];
};

/* Filter many frames at once */
var ff_filter_multi = Module.ff_filter_multi = function(buffersrc_ctx, buffersink_ctx, inFramePtr, inFrames, fin) {
    var outFrames = [];
    var outFramePtr = av_frame_alloc();
    if (outFramePtr === 0)
        throw new Error("Failed to allocate output frame");

    function handleFrame(inFrame) {
        if (inFrame !== null)
            ff_copyin_frame(inFramePtr, inFrame);

        var ret = av_buffersrc_add_frame_flags(buffersrc_ctx, inFrame ? inFramePtr : 0, 8 /* AV_BUFFERSRC_FLAG_KEEP_REF */);
        if (ret < 0)
            throw new Error("Error while feeding the audio filtergraph");
        av_frame_unref(inFramePtr);

        while (true) {
            ret = av_buffersink_get_frame(buffersink_ctx, outFramePtr);
            if (ret === -11 /* EGAIN */ || ret === -0x20464f45 /* AVERROR_EOF */)
                break;
            if (ret < 0)
                throw new Error("Error while receiving a frame from the filtergraph");
            var outFrame = ff_copyout_frame(outFramePtr);
            outFrame.data = outFrame.data.slice(0);
            outFrames.push(outFrame);
            av_frame_unref(outFramePtr);
        }
    }

    inFrames.forEach(handleFrame);

    if (fin)
        handleFrame(null);

    av_frame_free(outFramePtr);

    return outFrames;
};

/* Copy out a frame */
var ff_copyout_frame = Module.ff_copyout_frame = function(frame) {
    var channels = AVFrame_channels(frame);
    var nb_samples = AVFrame_nb_samples(frame);
    var ct = channels*nb_samples;
    var data = AVFrame_data_a(frame, 0);
    var outFrame = {
        data: null,
        channel_layout: AVFrame_channel_layout(frame),
        channels: channels,
        format: AVFrame_format(frame),
        nb_samples: AVFrame_nb_samples(frame),
        pts: AVFrame_pts(frame),
        ptshi: AVFrame_ptshi(frame),
        sample_rate: AVFrame_sample_rate(frame)
    };

    // FIXME: Need to support *every* format here
    switch (outFrame.format) {
        case 0: // U8
            outFrame.data = copyout_u8(data, ct);
            break;

        case 1: // S16
            outFrame.data = copyout_s16(data, ct);
            break;

        case 2: // S32
            outFrame.data = copyout_s32(data, ct);
            break;

        case 3: // FLT
            outFrame.data = copyout_f32(data, ct);
            break;
    }

    return outFrame;
};

/* Copy in a frame */
var ff_copyin_frame = Module.ff_copyin_frame = function(framePtr, frame) {
    [
        "channel_layout", "channels", "format", "pts", "ptshi", "sample_rate"
    ].forEach(function(key) {
        if (key in frame)
            Module["AVFrame_" + key + "_si"](framePtr, frame[key]);
    });

    /* FIXME: nb_samples needs to be divided by channel count, and we need to
     * clear the frame if this is problematic */
    AVFrame_nb_samples_s(framePtr, frame.data.length);

    // We may or may not need to actually allocate
    if (av_frame_make_writable(framePtr) < 0)
        if (av_frame_get_buffer(framePtr, 0) < 0)
            throw new Error("Failed to allocate frame buffers");

    var data = AVFrame_data_a(framePtr, 0);

    // FIXME: Need to support *every* format here
    switch (frame.format) {
        case 0: // U8
            copyin_u8(data, frame.data);
            break;

        case 1: // S16
            copyin_s16(data, frame.data);
            break;

        case 2: // S32
            copyin_s32(data, frame.data);
            break;

        case 3: // FLT
            copyin_f32(data, frame.data);
            break;
    }
};

/* Copy out a packet */
var ff_copyout_packet = Module.ff_copyout_packet = function(pkt) {
    var data = AVPacket_data(pkt);
    var size = AVPacket_size(pkt);
    return {
        data: copyout_u8(data, size),
        pts: AVPacket_pts(pkt),
        ptshi: AVPacket_ptshi(pkt),
        dts: AVPacket_dts(pkt),
        dtshi: AVPacket_dtshi(pkt),
        stream_index: AVPacket_stream_index(pkt)
    };
};

/* Copy in a packet */
var ff_copyin_packet = Module.ff_copyin_packet = function(pktPtr, packet) {
    ff_set_packet(pktPtr, packet.data);

    [
        "dts", "dtshi", "stream_index", "pts", "pts_hi"
    ].forEach(function(key) {
        if (key in packet)
            Module["AVPacket_" + key + "_si"](pktPtr, packet[key]);
    });
};

/* Allocate and copy in a 32-bit int list */
var ff_malloc_int32_list = Module.ff_malloc_int32_list = function(list) {
    var ptr = malloc(list.length * 4);
    if (ptr === 0)
        throw new Error("Failed to malloc");
    var arr = new Uint32Array(Module.HEAPU8.buffer, ptr, list.length);
    for (var i = 0; i < list.length; i++)
        arr[i] = list[i];
    return ptr;
};

/* Allocate and copy in a 64-bit int list */
var ff_malloc_int64_list = Module.ff_malloc_int64_list = function(list) {
    var ptr = malloc(list.length * 8);
    if (ptr === 0)
        throw new Error("Failed to malloc");
    var arr = new Int32Array(Module.HEAPU8.buffer, ptr, list.length*2);
    for (var i = 0; i < list.length; i++) {
        arr[i*2] = list[i];
        arr[i*2+1] = (list[i]<0)?-1:0;
    }
    return ptr;
};

if (typeof importScripts !== "undefined") {
    // We're a WebWorker, so arrange messages
    onmessage = function(e) {
        var id = e.data[0];
        var fun = e.data[1];
        var args = e.data.slice(2);
        var ret = void 0;
        var succ = true;
        try {
            ret = Module[fun].apply(Module, args);
        } catch (ex) {
            succ = false;
            ret = ex.toString() + "\n" + ex.stack;
        }
        postMessage([id, fun, succ, ret]);
    };

    Module.onRuntimeInitialized = function() {
        postMessage([0, "onRuntimeInitialized", true, null]);
    };

    Module.onwrite = function(name, pos, buf) {
        postMessage(["onwrite", "onwrite", true, [name, pos, buf]]);
    };
}
