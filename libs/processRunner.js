/*
Node-OpenDroneMap Node.js App and REST API to access OpenDroneMap.
Copyright (C) 2016 Node-OpenDroneMap Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
"use strict";
let fs = require('fs');
let path = require('path');
let assert = require('assert');
let spawn = require('child_process').spawn;
let config = require('../config.js');
let logger = require('./logger');
let utils = require('./utils');


function makeRunner(command, args, requiredOptions = [], outputTestFile = null, skipOnTest = true){
    return function(options, done, outputReceived){
        for (let requiredOption of requiredOptions){
            assert(options[requiredOption] !== undefined, `${requiredOption} must be defined`);
        }

        let commandArgs = args;
        if (typeof commandArgs === 'function') commandArgs = commandArgs(options);

        logger.info(`About to run: ${command} ${commandArgs.join(" ")}`);
        if (outputReceived !== undefined) outputReceived(`About to run: ${command} ${commandArgs.join(" ")}`);

        if (config.test && skipOnTest){
            logger.info("Test mode is on, command will not execute");

            if (outputTestFile){
                fs.readFile(path.resolve(__dirname, outputTestFile), 'utf8', (err, text) => {
                    if (!err){
                        if (outputReceived !== undefined){
                            let lines = text.split("\n");
                            lines.forEach(line => outputReceived(line));
                        }
                        
                        done(null, 0, null);
                    }else{
                        logger.warn(`Error: ${err.message}`);
                        done(err);
                    }
                });
            }else{
                done(null, 0, null);
            }

            return;// Skip rest
        }

        // Launch
        const env = utils.clone(process.env);
        env.LD_LIBRARY_PATH = path.join(config.odm_path, "SuperBuild", "install", "lib");
        
        let cwd = undefined;
        if (options.cwd) cwd = options.cwd;

        let childProcess = spawn(command, commandArgs, { env, cwd });

        childProcess
            .on('exit', (code, signal) => done(null, code, signal))
            .on('error', done);

        if (outputReceived !== undefined){
            childProcess.stdout.on('data', chunk => outputReceived(chunk.toString()));
            childProcess.stderr.on('data', chunk => outputReceived(chunk.toString()));
        }else{
            childProcess.stdout.on('data', () => {});
            childProcess.stderr.on('data', () => {});
        }

        return childProcess;
    };
}

module.exports = {
    runPostProcessingScript: makeRunner(path.join(__dirname, "..", "scripts", "postprocess.sh"),
                     function(options){
                         return [options.projectFolderPath];
                     },
                     ["projectFolderPath"]),

    sevenZip: makeRunner("7z", function(options){
            return ["a", "-mx=0", "-y", "-r", "-bd", options.destination].concat(options.pathsToArchive);
        },
        ["destination", "pathsToArchive", "cwd"],
        null,
        false),

    sevenUnzip: makeRunner("7z", function(options){
            let cmd = "x"; // eXtract files with full paths
            if (options.noDirectories) cmd = "e"; //Extract files from archive (without using directory names)

            return [cmd, "-aoa", "-bd", "-y", `-o${options.destination}`, options.file];
        },
        ["destination", "file"],
        null,
        false),

    unzip: makeRunner("unzip", function(options){
            const opts = options.noDirectories ? ["-j"] : [];
            return opts.concat(["-qq", "-o", options.file, "-d", options.destination]);
        },
        ["destination", "file"],
        null,
        false),

    runPotreeConverter: makeRunner("PotreeConverter", function (options) {
        return [options.input, "-o", options.outDir];
    }, ["input", "outDir"],
        null,
        false),

    runGenerateCog: makeRunner("gdal_translate", function (options) {
        const params = [
            options.inputPath, 
            options.outputPath, 
            "-of", "COG", 
            "-co", "BLOCKSIZE=256", 
            "-co", "COMPRESS=DEFLATE", 
            "-co", "BIGTIFF=IF_SAFER", 
            "-co", "RESAMPLING=NEAREST", 
            "-co", "TILING_SCHEME=GoogleMapsCompatible"
        ];

        return params;
    }, ["inputPath", "outputPath"],
       null, 
       false),

    runIfcConverter: makeRunner("IfcConvert", function (options) {
        return [options.inputFile, options.outputFile];
    }, ["inputFile", "outputFile"], 
       null, 
       false),

    runNxsBuild: makeRunner("nxsbuild", function (options) {
        return [
            options.inputOBJFile,
            "-m",
            options.inputMTLFile,
            "-o",
            options.outputFile,
            "-c",
        ];
    }, ["inputOBJFile", "inputMTLFile", "outputFile"], 
       null, 
       false),

    runNxsCompress: makeRunner("nxscompress", function (options) {
        return [options.inputFile, "-o", options.outputFile];
    }, ["inputFile", "outputFile"], 
       null, 
       false),

    runFixBB: makeRunner("lasinfo", function (options) {
        return ['-i', options.inputFile, '-repair_bb'];
    }, ['inputFile'],
        null,
        false),

    runClassify: makeRunner('pdal', (options) => {
        return ['translate', '-i', options.inputFile, '-o', options.inputFile, 'smrf', 'range', '--filters.range.limits=Classification[2:2]'];
    }, ['inputFile'],
        null,
        false),    

    runFindSrs: makeRunner('/usr/bin/node', options => {
        return [path.join(__dirname, "..", "scripts", "findSrs.js"), options.inputFile, options.outputFile];
    }, ['inputFile', 'outputFile'],
        null,
        false),

    runSgCompare: makeRunner('python', (options) => {
        return ['/Workspace/sg-compare/main.py', '-t1', options.prevFile, '-t2', options.nextFile, '-o', options.outputFile];
    }, ['prevFile', 'nextFile', 'outputFile'],
        null,
        false),

    runPdalTranslate: makeRunner('pdal', (options) => {
        return ['translate', '-i', options.inputFile, '-o', options.outputFile];
    }, ['inputFile', 'outputFile'],
        null,
        false),

    runBundleAdjustment: makeRunner('/usr/bin/node', options => {
        return [path.join(__dirname, "..", "scripts", "runBA.js"), options.projectFolderPath];
    }, ['projectFolderPath'],
        null,
        false)
};
