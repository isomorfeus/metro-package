'use strict';

// works with metro 0.56.x

const child_process = require('child_process');
const node_fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const process = require('process');
const JsTransformer = require("metro/src/JSTransformer/worker");
const { loadConfig } = require("metro-config");

// keep some global state
let Owl = {
    load_paths_cache: null,
    socket_path: null,
    module_start: 'const opal_code = function() {\n  global.Opal.modules[',
    compile_server_starting: false,
    socket_ready: false,
    options: null,
    socket_wait_counter: 0,
    is_stopping: false
};

const default_options = {
    hmrHook: '',
    sourceMap: false,
    includePaths: null,
    requireModules: null,
    dynamicRequireSeverity: null,
    compilerFlagsOn: null,
    compilerFlagsOff: null,
    memcached: null,
    redis: null
};

function handle_exit() {
    if (!Owl.is_stopping) {
        Owl.is_stopping = true;
        try { node_fs.unlinkSync(Owl.load_paths_cache); } catch (err) { }
        try {
            if (node_fs.existsSync(Owl.socket_path)) {
                // this doesnt seem to return, so anything below it is not executed
                child_process.spawnSync("bundle", ["exec", "opal-webpack-compile-server", "stop", "-s", Owl.socket_path], {timeout: 10000});
            }
        } catch (err) { }
        try { node_fs.unlinkSync(Owl.socket_path); } catch (err) { }
        try { node_fs.rmdirSync(process.env.OWL_TMPDIR); } catch (err) { }
    }
}
process.on('exit', function(code) { handle_exit(); });
process.on('SIGTERM', function(signal) { handle_exit(); });

class RubyTransformer {
    _config;
    _projectRoot;

    constructor(projectRoot, config) {
        this._projectRoot = projectRoot;
        this._config = config;
        this._upstreamTransfomer = new JsTransformer(projectRoot, config);
    }

    async transform(filename, data, options) {
        if (filename.endsWith('.rb')) {
            if (!Owl.socket_ready && !Owl.compile_server_starting) { await this.start_compile_server(); }
            let request_json = JSON.stringify({filename: filename, source_map: Owl.options.sourceMap});
            let compiled_code = await this.wait_for_socket_and_delegate(request_json);
            data = Buffer.from(compiled_code, 'utf-8');
        }
        return this._upstreamTransfomer.transform(filename, data, options);
    }

    getCacheKey() {
        return this._upstreamTransfomer.getCacheKey();
    }

    async delegate_compilation(request_json) {
        return new Promise((resolve, reject) => {
            let buffer = Buffer.alloc(0);
            // or let the source be compiled by the compile server
            let socket = net.connect(Owl.socket_path, function () {
                socket.write(request_json + "\x04"); // triggers compilation
            });
            socket.on('data', function (data) {
                buffer = Buffer.concat([buffer, data]);
            });
            socket.on('end', function () {
                let compiler_result = JSON.parse(buffer.toString('utf8'));
                if (typeof compiler_result.error !== 'undefined') {
                    throw new Error(
                        "opal-metro-transformer: A error occurred during compiling!\n" +
                        compiler_result.error.name + "\n" +
                        compiler_result.error.message + "\n" +
                        compiler_result.error.backtrace // that's ruby error.backtrace
                    );
                } else {
                    // if (real_resource_path.startsWith(that.rootContext)) {
                    // search for ruby module name in compiled file
                    let start_index = compiler_result.javascript.indexOf(Owl.module_start) + Owl.module_start.length;
                    let end_index = compiler_result.javascript.indexOf(']', start_index);
                    let opal_module_name = compiler_result.javascript.substr(start_index, end_index - start_index);
                    let hmreloader = `if (typeof module.hot !== 'undefined' && typeof module.hot.accept === 'function') {
    module.hot.accept(() => {
        if (typeof global.Opal !== 'undefined' && typeof Opal.require_table !== "undefined" && Opal.require_table['corelib/module']) {
            let already_loaded = false;
            if (typeof global.Opal.modules !== 'undefined') {
                if (typeof global.Opal.modules[${opal_module_name}] === 'function') {
                    already_loaded = true;
                }
            }
            opal_code();
            if (already_loaded) {
                try {
                    if (Opal.require_table[${opal_module_name}]) {
                        global.Opal.load.call(global.Opal, ${opal_module_name});
                    } else {
                        global.Opal.require.call(global.Opal, ${opal_module_name});
                    }
                    ${Owl.options.hmrHook}
                } catch (err) {
                    console.error(err.message);
                }
            } else {
                var start = new Date();
                var fun = function() {
                    try {
                        if (Opal.require_table[${opal_module_name}]) {
                            global.Opal.load.call(global.Opal, ${opal_module_name});
                        } else {
                            global.Opal.require.call(global.Opal, ${opal_module_name});
                        }
                        console.log('${opal_module_name}: loaded');
                        try {
                            ${Owl.options.hmrHook}
                        } catch (err) {
                            console.error(err.message);
                        }
                    } catch (err) {
                        if ((new Date() - start) > 5000) {
                            console.error(err.message);
                            console.log('${opal_module_name}: load timed out');
                        } else {
                            console.log('${opal_module_name}: deferring load');
                            setTimeout(fun, 100);
                        }
                    }
                }
                fun();
            }
        }
    });
}
module.exports = opal_code;
`;
                    let result = [compiler_result.javascript, hmreloader].join("\n");
                    resolve(result);
                }
            });
            socket.on('error', function (err) {
                // only with webpack-dev-server running, somehow connecting to the IPC sockets leads to ECONNREFUSED
                // even though the socket is alive. this happens every once in a while for some seconds
                // not sure why this happens, but looping here solves it after a while
                if (err.syscall === 'connect') {
                    setTimeout(function () {
                        this.delegate_compilation(request_json).then(result => { resolve(result); });
                    }, 100);
                } else {
                    reject(err);
                }
            });
        });
    }

    initialize_options(options) {
        Object.keys(default_options).forEach(
            (key) => { if (typeof options[key] === 'undefined') options[key] = default_options[key]; }
        );
        if (options.memcached === true) { options.memcached = 'localhost:11211'; }
        if (options.redis === true) { options.redis = 'redis://localhost:6379'; }
        return options;
    }

    async start_compile_server() {
        if (!Owl.options) {
            let metro_config = await loadConfig();
            if (typeof metro_config.resolver.ruby_options === 'object') {
                let options = metro_config.resolver.ruby_options;
                Owl.options = this.initialize_options(options);
            }
        }
        Owl.socket_path = path.join(process.env.OWL_TMPDIR, 'owcs_socket');
        if (!node_fs.existsSync(Owl.socket_path)) {
            Owl.compile_server_starting = true;
            // console.log('---->  Opal Ruby Compile Server starting  <----');
            Owl.load_paths_cache = path.join(process.env.OWL_TMPDIR, 'load_paths.json');
            let command_args = ["exec", "opal-webpack-compile-server", "start", os.cpus().length.toString(), "-l", Owl.load_paths_cache, "-s", Owl.socket_path];

            if (Owl.options.dynamicRequireSeverity) command_args.push('-d', Owl.options.dynamicRequireSeverity);
            if (Owl.options.memcached) command_args.push('-m', Owl.options.memcached);
            else if (Owl.options.redis) command_args.push('-e', Owl.options.redis);

            (Owl.options.includePaths || []).forEach((path) => command_args.push('-I', path));
            (Owl.options.requireModules || []).forEach((requiredModule) => command_args.push('-r', requiredModule));
            (Owl.options.compilerFlagsOn || []).forEach((flagOn) => command_args.push('-t', flagOn));
            (Owl.options.compilerFlagsOff || []).forEach((flagOff) => command_args.push('-f', flagOff));

            let compile_server = child_process.spawn("bundle", command_args, { detached: true, stdio: 'ignore' });
            compile_server.unref();
        } else {
            Owl.socket_ready = true;
            // throw(new Error("opal-metro-transformer: compile server socket in use by another process"));
        }
    }

    async wait_for_socket_and_delegate(request_json) {
        if (Owl.socket_ready) {
            return this.delegate_compilation(request_json);
        } else if (node_fs.existsSync(Owl.socket_path)) {
            Owl.socket_ready = true;
            return this.delegate_compilation(request_json);
        } else {
            let that = this;
            return new Promise((resolve, reject) => {
                setTimeout(function () {
                    if (Owl.socket_wait_counter > 600) {
                        throw new Error('opal-webpack-loader: Unable to connect to compile server!');
                    }
                    that.wait_for_socket_and_delegate(request_json).then(result => {
                        resolve(result);
                    });
                }, 50);
            })
        }
    }
}

module.exports = RubyTransformer;
