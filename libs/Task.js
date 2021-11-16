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

const config = require("../config");
const async = require("async");
const assert = require("assert");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");
const rmdir = require("rimraf");
const odmRunner = require("./odmRunner");
const processRunner = require("./processRunner");
const Directories = require("./Directories");
const kill = require("tree-kill");
const S3 = require("./S3");
const request = require("request");
const utils = require("./utils");
const archiver = require("archiver");

const stream = require('stream');
const readline = require('readline');
const AbstractTask = require('./AbstractTask');


const statusCodes = require("./statusCodes");

module.exports = class Task extends AbstractTask {
    constructor(
        uuid,
        projectId,
        imageLinks = [],
        name,
        options = [],
        webhook = null,
        skipPostProcessing = false,
        outputs = [],
        output,
        dateCreated = new Date().getTime(),
        done = () => {}
    ) {
        super();
        
        assert(projectId !== undefined, 'projectId must be set');
        assert(uuid !== undefined, "uuid must be set");
        assert(done !== undefined, "ready must be set");

        this.uuid = uuid;
        this.projectId = projectId;
        this.imageLinks = imageLinks;
        this.name = name !== "" ? name : "Task of " + new Date().toISOString();
        this.dateCreated = isNaN(parseInt(dateCreated))
            ? new Date().getTime()
            : parseInt(dateCreated);
        this.dateStarted = 0;
        this.processingTime = -1;
        this.setStatus(statusCodes.QUEUED);
        this.options = options;
        this.gcpFiles = [];
        this.geoFiles = [];
        this.imageGroupsFiles = [];
        this.output = output || [];
        this.runningProcesses = [];
        this.webhook = webhook;
        this.skipPostProcessing = skipPostProcessing;
        this.outputs = utils.parseUnsafePathsList(outputs);
        this.progress = 0;

        async.series(
            [
                // Read images info
                (cb) => {
                    fs.readdir(this.getImagesFolderPath(), (err, files) => {
                        if (err) cb(err);
                        else {
                            this.images = files;
                            logger.debug(
                                `Found ${this.images.length} images for ${this.uuid}`
                            );
                            cb(null);
                        }
                    });
                },

                // Find GCP (if any)
                (cb) => {
                    fs.readdir(this.getGcpFolderPath(), (err, files) => {
                        if (err) cb(err);
                        else {
                            files.forEach((file) => {
                                if (/^geo\.txt$/gi.test(file)) {
                                    this.geoFiles.push(file);
                                } else if (/^image_groups\.txt$/gi.test(file)) {
                                    this.imageGroupsFiles.push(file);
                                } else if (/\.txt$/gi.test(file)) {
                                    this.gcpFiles.push(file);
                                }
                            });
                            logger.debug(
                                `Found ${
                                    this.gcpFiles.length
                                } GCP files (${this.gcpFiles.join(" ")}) for ${
                                    this.uuid
                                }`
                            );
                            logger.debug(
                                `Found ${
                                    this.geoFiles.length
                                } GEO files (${this.geoFiles.join(" ")}) for ${
                                    this.uuid
                                }`
                            );
                            logger.debug(
                                `Found ${
                                    this.imageGroupsFiles.length
                                } image groups files (${this.imageGroupsFiles.join(
                                    " "
                                )}) for ${this.uuid}`
                            );
                            cb(null);
                        }
                    });
                },
            ],
            (err) => {
                done(err, this);
            }
        );
    }

    static CreateFromSerialized(taskJson, done) {
        new Task(
            taskJson.uuid,
            taskJson.projectId,
            taskJson.imageLinks,
            taskJson.name,
            taskJson.options,
            taskJson.webhook,
            taskJson.skipPostProcessing,
            taskJson.outputs,
            taskJson.output,
            taskJson.dateCreated,
            (err, task) => {
                if (err) done(err);
                else {
                    // Override default values with those
                    // provided in the taskJson
                    for (let k in taskJson) {
                        task[k] = taskJson[k];
                    }

                    // Tasks that were running should be put back to QUEUED state
                    if (task.status.code === statusCodes.RUNNING) {
                        task.status.code = statusCodes.QUEUED;
                    }
                    done(null, task);
                }
            }
        );
    }

    // Get path where images are stored for this task
    // (relative to nodejs process CWD)
    getImagesFolderPath() {
        return path.join(this.getProjectFolderPath(), "images");
    }

    // Get path where GCP file(s) are stored
    // (relative to nodejs process CWD)
    getGcpFolderPath() {
        return path.join(this.getProjectFolderPath(), "gcp");
    }

    // Get path of project (where all images and assets folder are contained)
    // (relative to nodejs process CWD)
    getProjectFolderPath() {
        return path.join(Directories.data, this.uuid);
    }

    // Get the path of the archive where all assets
    // outputted by this task are stored.
    getAssetsArchivePath(filename) {
        if (filename == "all.zip") {
            // OK, do nothing
        } else if (filename == "mesh.zip") {
            // Also OK, do nothing
        } else {
            return false; // Invalid
        }

        return path.join(this.getProjectFolderPath(), filename);
    }

    // Deletes files and folders related to this task
    cleanup(cb) {
        rmdir(this.getProjectFolderPath(), cb);
    }

    setStatus(code, extra) {
        this.status = {
            code: code,
        };
        for (let k in extra) {
            this.status[k] = extra[k];
        }
    }

    updateProgress(globalProgress) {
        globalProgress = Math.min(100, Math.max(0, globalProgress));

        // Progress updates are asynchronous (via UDP)
        // so things could be out of order. We ignore all progress
        // updates that are lower than what we might have previously received.
        if (globalProgress >= this.progress) {
            this.progress = globalProgress;
        }

        this.callWebhooks();
    }

    updateProcessingTime(resetTime) {
        this.processingTime = resetTime
            ? -1
            : new Date().getTime() - this.dateCreated;
    }

    startTrackingProcessingTime() {
        this.updateProcessingTime();
        if (!this._updateProcessingTimeInterval) {
            this._updateProcessingTimeInterval = setInterval(() => {
                this.updateProcessingTime();
            }, 1000);
        }
    }

    stopTrackingProcessingTime(resetTime) {
        this.updateProcessingTime(resetTime);
        if (this._updateProcessingTimeInterval) {
            clearInterval(this._updateProcessingTimeInterval);
            this._updateProcessingTimeInterval = null;
        }
    }

    getStatus() {
        return this.status.code;
    }

    isCanceled() {
        return this.status.code === statusCodes.CANCELED;
    }

    isRunning() {
        return this.status.code === statusCodes.RUNNING;
    }

    // Cancels the current task (unless it's already canceled)
    cancel(cb) {
        if (this.status.code !== statusCodes.CANCELED) {
            let wasRunning = this.status.code === statusCodes.RUNNING;
            this.setStatus(statusCodes.CANCELED);

            if (wasRunning) {
                this.runningProcesses.forEach((proc) => {
                    // TODO: this does NOT guarantee that
                    // the process will immediately terminate.
                    // For eaxmple in the case of the ODM process, the process will continue running for a while
                    // This might need to be fixed on ODM's end.

                    // During testing, proc is undefined
                    if (proc) kill(proc.pid);
                });
                this.runningProcesses = [];
            }

            this.stopTrackingProcessingTime(true);
            cb(null);
        } else {
            cb(new Error("Task already cancelled"));
        }
    }

    // Starts processing the task with OpenDroneMap
    // This will spawn a new process.
    start(done) {

        const finished = (error) => {
            const taskOutputFile = path.join(
                this.getProjectFolderPath(),
                "task_output.txt"
            );

            fs.writeFileSync(taskOutputFile, this.output.join("\n"));

            S3.uploadSingle(
                `project/${this.projectId}/process/${this.uuid}/task_output.txt`,
                taskOutputFile,
                (uploadError) => {
                    if (uploadError) console.log(uploadError);
                    else console.log('task_output file sent...');

                    this.updateProgress(100);
                    this.stopTrackingProcessingTime();
                    done(error);
                },
                () => {}
            )
        };

        const postProcess = () => {
            const createZipArchive = (outputFilename, files) => {
                return (done) => {
                    this.output.push(`Compressing ${outputFilename}\n`);

                    const zipFile = path.resolve(
                        this.getAssetsArchivePath(outputFilename)
                    );
                    const sourcePath = !config.test
                        ? this.getProjectFolderPath()
                        : path.join("tests", "processing_results");

                    const pathsToArchive = [];
                    files.forEach((f) => {
                        if (fs.existsSync(path.resolve(sourcePath, f))) {
                            pathsToArchive.push(f);
                        }
                    });

                    processRunner.sevenZip(
                        {
                            destination: zipFile,
                            pathsToArchive,
                            cwd: sourcePath,
                        },
                        (err, code, _) => {
                            if (err) {
                                logger.error(
                                    `Could not archive .zip file: ${err.message}`
                                );
                                done(err);
                            } else {
                                if (code === 0) {
                                    this.updateProgress(97);
                                    done();
                                } else
                                    done(
                                        new Error(
                                            `Could not archive .zip file, 7z exited with code ${code}`
                                        )
                                    );
                            }
                        }
                    );
                };
            };

            const createZipArchiveLegacy = (outputFilename, files) => {
                return (done) => {
                    this.output.push(`Compressing ${outputFilename}\n`);

                    let output = fs.createWriteStream(
                        this.getAssetsArchivePath(outputFilename)
                    );
                    let archive = archiver.create("zip", {
                        zlib: { level: 1 }, // Sets the compression level (1 = best speed since most assets are already compressed)
                    });

                    archive.on("finish", () => {
                        this.updateProgress(97);
                        // TODO: is this being fired twice?
                        done();
                    });

                    archive.on("error", (err) => {
                        logger.error(
                            `Could not archive .zip file: ${err.message}`
                        );
                        done(err);
                    });

                    archive.pipe(output);
                    let globs = [];

                    const sourcePath = !config.test
                        ? this.getProjectFolderPath()
                        : path.join("tests", "processing_results");

                    // Process files and directories first
                    files.forEach((file) => {
                        let filePath = path.join(sourcePath, file);

                        // Skip non-existing items
                        if (!fs.existsSync(filePath)) return;

                        let isGlob = /\*/.test(file),
                            isDirectory =
                                !isGlob && fs.lstatSync(filePath).isDirectory();

                        if (isDirectory) {
                            archive.directory(filePath, file);
                        } else if (isGlob) {
                            globs.push(filePath);
                        } else {
                            archive.file(filePath, { name: file });
                        }
                    });

                    // Check for globs
                    if (globs.length !== 0) {
                        let pending = globs.length;

                        globs.forEach((pattern) => {
                            glob(pattern, (err, files) => {
                                if (err) done(err);
                                else {
                                    files.forEach((file) => {
                                        if (fs.lstatSync(file).isFile()) {
                                            archive.file(file, {
                                                name: path.basename(file),
                                            });
                                        } else {
                                            logger.debug(
                                                `Could not add ${file} from glob`
                                            );
                                        }
                                    });

                                    if (--pending === 0) {
                                        archive.finalize();
                                    }
                                }
                            });
                        });
                    } else {
                        archive.finalize();
                    }
                };
            };

            const runPostProcessingScript = () => {
                return (done) => {
                    this.runningProcesses.push(
                        processRunner.runPostProcessingScript(
                            {
                                projectFolderPath: this.getProjectFolderPath(),
                            },
                            (err, code, _) => {
                                if (err) done(err);
                                else {
                                    if (code === 0) {
                                        this.updateProgress(93);
                                        done();
                                    } else
                                        done(
                                            new Error(
                                                `Process exited with code ${code}`
                                            )
                                        );
                                }
                            },
                            (output) => {
                                this.output.push(output);
                            }
                        )
                    );
                };
            };

            // All paths are relative to the project directory (./data/<uuid>/)
            let allPaths = [
                "odm_orthophoto/odm_orthophoto.tif",
                "odm_orthophoto/odm_orthophoto.png",
                "odm_orthophoto/odm_orthophoto.mbtiles",
                "odm_georeferencing",
                "odm_texturing",
                "odm_dem/dsm.tif",
                "odm_dem/dtm.tif",
                "dsm_tiles",
                "dtm_tiles",
                "orthophoto_tiles",
                "potree_pointcloud",
                "entwine_pointcloud",
                "images.json",
                "cameras.json",
                "task_output.txt",
                "odm_report",
            ];

            // Did the user request different outputs than the default?
            if (this.outputs.length > 0) allPaths = this.outputs;

            let tasks = [];

            if (config.test) {
                if (config.testSkipOrthophotos) {
                    logger.info("Test mode will skip orthophoto generation");

                    // Exclude these folders from the all.zip archive
                    [
                        "odm_orthophoto/odm_orthophoto.tif",
                        "odm_orthophoto/odm_orthophoto.mbtiles",
                        "orthophoto_tiles",
                    ].forEach((dir) => {
                        allPaths.splice(allPaths.indexOf(dir), 1);
                    });
                }

                if (config.testSkipDems) {
                    logger.info("Test mode will skip DEMs generation");

                    // Exclude these folders from the all.zip archive
                    [
                        "odm_dem/dsm.tif",
                        "odm_dem/dtm.tif",
                        "dsm_tiles",
                        "dtm_tiles",
                    ].forEach((p) => {
                        allPaths.splice(allPaths.indexOf(p), 1);
                    });
                }

                if (config.testSeconds) {
                    logger.info(
                        `Test mode will sleep for ${config.testSeconds} seconds before finishing processing`
                    );
                    tasks.push((done) =>
                        setTimeout(done, config.testSeconds * 1000)
                    );
                }

                if (config.testFailTasks) {
                    logger.info("Test mode will fail the task");
                    tasks.push((done) => done(new Error("Test fail")));
                }
            }

            if (!this.skipPostProcessing && !this.projectId) tasks.push(runPostProcessingScript());

            // Sahagozu specific postProcesses

            // TODO
            // if options include end-with with value opensfm, call upload reconstruction.json then notify webhook and stop here(return)

            if (this.projectId && allPaths.includes('odm_georeferencing') || allPaths.includes('odm_georeferencing/odm_georeferenced_model.laz')) {
                // pointcloud output is wanted, run necessary post processing
                
                // sometimes output pointcloud has some points that are not in the bounding box of the header. This should fix those.
                tasks.push(this.runPostProcess('pointcloud_pre'));

                // convert
                tasks.push(this.runPostProcess('pointcloud'));

                // writes coord info into metadata.json
                tasks.push(this.runPostProcess('pointcloud_post'));
            }

            if (this.projectId && allPaths.includes('odm_orthophoto') || allPaths.includes('odm_orthophoto/odm_orthophoto.tif')) {
                // orthophoto output is wanted, run necessary post processing
                tasks.push(this.runPostProcess('orthophoto'));
            }

            if (this.projectId && allPaths.includes('odm_texturing') || allPaths.includes('odm_texturing/odm_textured_model.obj')){
                // mesh output is wanted, run necessary post processing
                if (!fs.existsSync(path.join(this.getProjectFolderPath(), 'nexus'))) {
                    fs.mkdirSync(path.join(this.getProjectFolderPath(), 'nexus'));
                }
                tasks.push(this.runPostProcess('mesh_initial'));
                tasks.push(this.runPostProcess('mesh_post'));
            }


            const archiveFunc = config.has7z
                ? createZipArchive
                : createZipArchiveLegacy;
            if (!this.projectId)
                tasks.push(archiveFunc("all.zip", allPaths));

            // Upload to S3 all paths + all.zip file (if config says so)
            if (S3.enabled()) {
                if (!this.projectId) {
                    // regular s3 upload 
                    tasks.push((done) => {
                        let s3Paths;
                        if (config.s3UploadEverything) {
                            s3Paths = ["all.zip"].concat(allPaths);
                        } else {
                            s3Paths = ["all.zip"];
                        }

                        S3.uploadPaths(
                            this.getProjectFolderPath(),
                            config.s3Bucket,
                            this.uuid,
                            s3Paths,
                            (err) => {
                                if (!err) this.output.push("Done uploading to S3!");
                                done(err);
                            },
                            (output) => this.output.push(output)
                        );
                    });
                } else {
                    // sg s3 uplaod

                    if (allPaths.includes('odm_georeferencing') || allPaths.includes('odm_georeferencing/odm_georeferenced_model.laz')) {
                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/pointcloud/${this.uuid}_pointcloud.laz`,
                                path.join(this.getProjectFolderPath(),'odm_georeferencing','odm_georeferenced_model.laz'),
                                (err) => {
                                    if (!err) this.output.push('Uploaded pointcloud, continuing')
                                    done(err);
                                },
                                (output) => this.output.push(output)
                            )
                        });
                        tasks.push((done) => {
                            S3.uploadPaths(
                                this.getProjectFolderPath(),
                                config.s3Bucket,
                                `project/${this.projectId}/process/${this.uuid}`,
                                ['potree_pointcloud'],
                                (err) => {
                                    if (!err) this.output.push('Done uploading potree_pointcloud, continuing');
                                    done(err);
                                },
                                (output) => this.output.push(output)
                            )
                        });
                        tasks.push(done => {
                            this.callWebhooks('pointcloud');
                            done(null);
                        });
                    }

                    if (allPaths.includes('odm_orthophoto') || allPaths.includes('odm_orthophoto/odm_orthophoto.tif')) {
                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/orthophoto/orthophoto-cog.tif`,
                                path.join(this.getProjectFolderPath(),'odm_orthophoto','odm_orthophoto-cog.tif'),
                                (err) => {
                                    if (!err) this.output.push('Uploaded orthophoto, continuing');
                                    done(err);
                                },
                                (output) => this.output.push(output)
                            )
                        });

                        tasks.push(done => {
                            this.callWebhooks('orthophoto');
                            done(null);
                        });
                    }

                    if (allPaths.includes("odm_dem/dsm.tif")) {
                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/dem/dsm.tif`,
                                path.join(
                                    this.getProjectFolderPath(),
                                    "odm_dem",
                                    "dsm.tif"
                                ),
                                (err) => {
                                    if (!err)
                                        this.output.push(
                                            "Uploaded dsm, continuing"
                                        );
                                    done(err);
                                },
                                (output) => this.output.push(output)
                            );
                        });

                        tasks.push(done => {
                            this.callWebhooks('dsm');
                            done(null);
                        });
                    }

                    if (allPaths.includes("odm_dem/dtm.tif")) {
                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/dem/dtm.tif`,
                                path.join(
                                    this.getProjectFolderPath(),
                                    "odm_dem",
                                    "dtm.tif"
                                ),
                                (err) => {
                                    if (!err)
                                        this.output.push(
                                            "Uploaded dtm, continuing"
                                        );
                                    done(err);
                                },
                                (output) => this.output.push(output)
                            );
                        });

                        tasks.push(done => {
                            this.callWebhooks('dtm');
                            done(null);
                        });                          
                    }

                    if (allPaths.includes('odm_texturing') || allPaths.includes('odm_texturing/odm_textured_model.obj')) {
                        const meshCanditatePaths = fs.readdirSync(path.join(this.getProjectFolderPath(), 'odm_texturing'));
                        const meshPaths = meshCanditatePaths.filter(p => {
                            if (!p.includes('geo')) 
                                return false;

                            if (p.substr(-4) === 'conf')
                                return false;

                            return true;
                        }).map(e => path.join(this.getProjectFolderPath(), 'odm_texturing', e));


                        tasks.push(done => {
                            const mtlPath = path.join(this.getProjectFolderPath(), 'odm_texturing', 'odm_textured_model_geo.mtl');
                            const mtlFile = fs.readFileSync(mtlPath, { encoding: 'utf-8'});

                            fs.writeFileSync(mtlPath, mtlFile.replace(/odm_textured_model_geo/g, 'mesh', ));

                            const modifiedMeshPaths = meshPaths.map(f => { 
                                const newPath = f.replace('odm_textured_model_geo', 'mesh');
                                fs.renameSync(f, newPath);

                                return path.resolve(process.cwd(), newPath);
                            });

                            const objPath = path.join(this.getProjectFolderPath(), 'odm_texturing', 'mesh.obj');
                            const rs = fs.createReadStream(objPath);
                            const ws = fs.createWriteStream(objPath + '.tmp');

                            const rl = readline.createInterface(rs, stream);

                            rl.on('line', l => {
                                if (l.substr(0, 6) === 'mtllib') {
                                    return ws.write('mtllib mesh.mtl\n');
                                }

                                ws.write(l + '\n');
                            });

                            rl.on('close', () => {
                                ws.end(() => {
                                    fs.unlinkSync(objPath);
                                    fs.renameSync(objPath + '.tmp', objPath);
                                    archiveFunc("mesh.zip", modifiedMeshPaths)(done);
                                });
                            });
                        });

                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/mesh/mesh.zip`,
                                this.getAssetsArchivePath('mesh.zip'),
                                (err) => {
                                    if (!err) this.output.push('Uploaded mesh.zip, continuing');
                                    done(err);
                                },
                                (output) => this.output.push(output)
                            )
                        });

                        tasks.push(done => {
                            this.callWebhooks('mesh');
                            done(null);
                        });                          

                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/nexus/nexus.nxz`,
                                path.join(this.getProjectFolderPath(), 'nexus',  'nexus.nxz'),
                                (err) => {
                                    if (!err) this.output.push('Uploaded nexus.nxz, continuing');
                                    done(err);
                                },
                                (output) => this.output.push(output)
                            )
                        });

                        tasks.push(done => {
                            this.callWebhooks('nexus');
                            done(null);
                        });                         

                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/ai/tracks.csv`,
                                path.join(this.getProjectFolderPath(), 'opensfm', 'tracks.csv'),
                                (err) => {
                                    if (!err) this.output.push('Uploaded tracks.csv, continuing');
                                    done(err);
                                }
                            )
                        });

                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/ai/reconstruction.json`,
                                path.join(this.getProjectFolderPath(), 'opensfm', 'reconstruction.json'),
                                (err) => {
                                    if (!err) this.output.push('Uploaded reconstruction.json, continuing');
                                    done(err);
                                }
                            )
                        });

                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/report/report.pdf`,
                                path.join(this.getProjectFolderPath(), 'odm_report', 'report.pdf'),
                                (err) => {
                                    if (!err) this.output.push('Uploaded report.pdf, continuing');
                                    done(err);
                                }
                            )
                        });

                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/report/stats.json`,
                                path.join(this.getProjectFolderPath(), 'odm_report', 'stats.json'),
                                (err) => {
                                    if (!err) this.output.push('Uploaded stats.json, finishing');
                                    done(err);
                                }
                            )
                        });

                        tasks.push((done) => {
                            S3.uploadSingle(
                                `project/${this.projectId}/process/${this.uuid}/report/shots.geojson`,
                                path.join(this.getProjectFolderPath(), 'odm_report', 'shots.geojson'),
                                (err) => {
                                    if (!err) this.output.push('Uploaded shots.geojson, finishing');
                                    done(err);
                                }
                            )
                        });
                    }
                }
            }

            async.series(tasks, (err) => {
                if (!err) {
                    this.setStatus(statusCodes.COMPLETED);
                    finished();
                } else {
                    this.setStatus(statusCodes.FAILED);
                    finished(err);
                }
            });
        };

        if (this.status.code === statusCodes.QUEUED) {
            this.startTrackingProcessingTime();
            this.dateStarted = new Date().getTime();
            this.setStatus(statusCodes.RUNNING);
            this.callWebhooks();

            let runnerOptions = this.options.reduce((result, opt) => {
                result[opt.name] = opt.value;
                return result;
            }, {});

            runnerOptions["project-path"] = fs.realpathSync(Directories.data);

            if (this.outputs.length && this.outputs.includes("odm_dem/dtm.tif")) 
                runnerOptions["dtm"] = true;
            

            if (this.outputs.length && this.outputs.includes("odm_dem/dsm.tif"))
                runnerOptions["dsm"] = true;

            const downloadTasks = this.imageLinks.length ? this.imageLinks.map(dlLink => cb => {
                const imageName = dlLink.split('/').pop();
                const p = path.join(this.getImagesFolderPath(), imageName);
                this.output.push(`downloading ${p} ...`);
                S3.downloadPath(dlLink, p, (err) => {
                    if (err) cb(err);
                    else cb(null)
                }) 
            }) : [cb => cb(null)];

            async.parallelLimit(downloadTasks, 4, (err) => {
                if (err) {
                    this.setStatus(statusCodes.FAILED, {
                        errorMessage: `Could not download using imageLinks : (${err.message})`,
                    });
                    finished(err);
                } else {
                    // TODO update this.images
                    if (this.gcpFiles.length > 0) {
                        runnerOptions.gcp = fs.realpathSync(
                            path.join(this.getGcpFolderPath(), this.gcpFiles[0])
                        );
                    }
                    if (this.geoFiles.length > 0) {
                        runnerOptions.geo = fs.realpathSync(
                            path.join(this.getGcpFolderPath(), this.geoFiles[0])
                        );
                    }
                    if (this.imageGroupsFiles.length > 0) {
                        runnerOptions["split-image-groups"] = fs.realpathSync(
                            path.join(this.getGcpFolderPath(), this.imageGroupsFiles[0])
                        );
                    }

                    this.runningProcesses.push(
                        odmRunner.run(
                            runnerOptions,
                            this.uuid,
                            (err, code, signal) => {
                                if (err) {
                                    this.setStatus(statusCodes.FAILED, {
                                        errorMessage: `Could not start process (${err.message})`,
                                    });
                                    finished(err);
                                } else {
                                    // Don't evaluate if we caused the process to exit via SIGINT?
                                    if (this.status.code !== statusCodes.CANCELED) {
                                        if (code === 0) {
                                            postProcess();
                                        } else {
                                            this.setStatus(statusCodes.FAILED, {
                                                errorMessage: `Process exited with code ${code}`,
                                            });
                                            finished();
                                        }
                                    } else {
                                        finished();
                                    }
                                }
                            },
                            (output) => {
                                // Replace console colors
                                output = output.replace(/\x1b\[[0-9;]*m/g, "");

                                // Split lines and trim
                                output
                                    .trim()
                                    .split("\n")
                                    .forEach((line) => {
                                        this.output.push(line.trim());
                                    });
                            }
                        )
                    );
                }
            });

            return true;
        } else {
            return false;
        }
    }

    runPostProcess (type) {
        let opts;
        let runner;

        switch (type) {
            case 'pointcloud_pre':
                opts = {
                    inputFile: path.join(this.getProjectFolderPath(), 'odm_georeferencing', 'odm_georeferenced_model.laz')
                };
                runner = processRunner.runFixBB;
                break;
            case 'pointcloud':
                opts = {
                    input: path.join(this.getProjectFolderPath(), 'odm_georeferencing', 'odm_georeferenced_model.laz'),
                    outDir: path.join(this.getProjectFolderPath(), 'potree_pointcloud')
                };
                runner = processRunner.runPotreeConverter;
                break;
            case "pointcloud_post":
                opts = {
                    inputFile: path.join(this.getProjectFolderPath(), 'odm_georeferencing', 'odm_georeferenced_model.laz'),
                    outputFile: path.join(this.getProjectFolderPath(), 'potree_pointcloud', 'metadata.json')
                };
                runner = processRunner.runFindSrs;
                break;
            case 'orthophoto':
                opts = {
                    inputPath: path.join(this.getProjectFolderPath(), 'odm_orthophoto', 'odm_orthophoto.tif'),
                    outputPath: path.join(this.getProjectFolderPath(), 'odm_orthophoto', 'odm_orthophoto-cog.tif')
                };
                runner = processRunner.runGenerateCog;
                break;
            case 'mesh_initial':
                opts = {
                    inputOBJFile: path.join(this.getProjectFolderPath(), 'odm_texturing', 'odm_textured_model_geo.obj'),
                    inputMTLFile: path.join(this.getProjectFolderPath(), 'odm_texturing', 'odm_textured_model_geo.mtl'),
                    outputFile: path.join(this.getProjectFolderPath(), 'nexus', 'nexus.nxs')
                };
                runner = processRunner.runNxsBuild;
                break;
            case 'mesh_post':
                opts = {
                    inputFile: path.join(this.getProjectFolderPath(), 'nexus', 'nexus.nxs'),
                    outputFile: path.join(this.getProjectFolderPath(), 'nexus', 'nexus.nxz')
                };
                runner = processRunner.runNxsCompress;
                break;
            default:
                return (done) => done();
        }

        return (done) => {
            this.runningProcesses.push(
                runner(opts,
                    (err, code, _) => {
                        if (err) {
                            console.log(err);
                            done(err);
                        }
                        else {
                            if (code === 0) {
                                this.updateProgress(93);
                                done();
                            } else
                                done(
                                    new Error(
                                        `Process exited with code ${code}`
                                    )
                                );
                        }
                    },
                    (output) => {
                        this.output.push(output);
                    }
                )
            )
        }
    }

    // Re-executes the task (by setting it's state back to QUEUED)
    // Only tasks that have been canceled, completed or have failed can be restarted.
    restart(options, cb) {
        if (
            [
                statusCodes.CANCELED,
                statusCodes.FAILED,
                statusCodes.COMPLETED,
            ].indexOf(this.status.code) !== -1
        ) {
            this.setStatus(statusCodes.QUEUED);
            this.dateCreated = new Date().getTime();
            this.dateStarted = 0;
            this.output = [];
            this.progress = 0;
            this.stopTrackingProcessingTime(true);
            if (options !== undefined) this.options = options;
            cb(null);
        } else {
            cb(new Error("Task cannot be restarted"));
        }
    }

    // Returns the description of the task.
    getInfo() {
        return {
            uuid: this.uuid,
            name: this.name,
            projectId: this.projectId,
            dateCreated: this.dateCreated,
            processingTime: this.processingTime,
            status: this.status,
            options: this.options,
            imagesCount: this.images.length,
            progress: this.progress,
        };
    }

    // Returns the output of the OpenDroneMap process
    // Optionally starting from a certain line number
    getOutput(startFromLine = 0) {
        return this.output.slice(startFromLine, this.output.length);
    }

    // Reads the contents of the tasks's
    // images.json and returns its JSON representation
    readImagesDatabase(callback) {
        const imagesDbPath = !config.test
            ? path.join(this.getProjectFolderPath(), "images.json")
            : path.join("tests", "processing_results", "images.json");

        fs.readFile(imagesDbPath, "utf8", (err, data) => {
            if (err) callback(err);
            else {
                try {
                    const json = JSON.parse(data);
                    callback(null, json);
                } catch (e) {
                    callback(e);
                }
            }
        });
    }

    callWebhooks(resourceType) {
        // Hooks can be passed via command line
        // or for each individual task
        // const hooks = [this.webhook, config.webhook];
        const hooks = [this.webhook];
        let json = this.getInfo();

        if (resourceType) json.resourceType = resourceType;

        hooks.forEach((hook) => {
            if (hook && hook.length > 3) {
                const notifyCallback = (attempt) => {
                    if (attempt > 5) {
                        logger.warn(
                            `Webhook invokation failed, will not retry: ${hook}`
                        );
                        return;
                    }
                    request.post(hook, { json }, (error, response) => {
                        if (error || response.statusCode != 200) {
                            logger.warn(
                                `Webhook invokation failed, will retry in a bit: ${hook}`
                            );
                            setTimeout(() => {
                                notifyCallback(attempt + 1);
                            }, attempt * 5000);
                        } else {
                            logger.debug(`Webhook invoked: ${hook}`);
                        }
                    });
                };
                notifyCallback(0);
            }
        });
    }

    // Returns the data necessary to serialize this
    // task to restore it later.
    serialize() {
        return {
            uuid: this.uuid,
            projectId: this.projectId,
            name: this.name,
            dateCreated: this.dateCreated,
            dateStarted: this.dateStarted,
            status: this.status,
            options: this.options,
            webhook: this.webhook,
            skipPostProcessing: !!this.skipPostProcessing,
            outputs: this.outputs || [],
            output: this.output
        };
    }
};
