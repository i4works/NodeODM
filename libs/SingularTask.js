"use strict";

const async = require("async");
const path = require("path");
const kill = require("tree-kill");
const assert = require("assert");
const rmdir = require("rimraf");
const fs = require("fs");
const request = require("request");

const config = require("../config");
const AbstractTask = require("./AbstractTask");
const processRunner = require("./processRunner");
const Directories = require("./Directories");
const S3 = require("./S3");
const zipUtils = require('./ziputils');
const logger = require("./logger");

const statusCodes = require('./statusCodes');


module.exports = class SingularTask extends AbstractTask {
    constructor(
        uuid,
        projectId,
        name,
        options = [],
        webhook = null,
        taskType,
        output,
        dateCreated = new Date().getTime(),
        done = () => {}
    ) {
        super();
        assert(projectId !== undefined, 'projectId must be set');
        assert(uuid !== undefined, "uuid must be set");
        assert(done !== undefined, "ready must be set");
        assert(taskType !== undefined, "taskType must be set");
        assert(options.length, 'options must be set');

        this.uuid = uuid;
        this.projectId = projectId;
        this.options = options;
        this.taskType = taskType;
        this.webhook = webhook;
        this.name = name !== "" ? name : "Task of " + new Date().toISOString();
        this.dateCreated = isNaN(parseInt(dateCreated))
            ? new Date().getTime()
            : parseInt(dateCreated);
        this.dateStarted = 0;
        this.processingTime = -1;
        this.progress = 0;
        this.runningProcesses = [];
        this.output = output || [];
        this.setStatus(statusCodes.QUEUED);
        done(null, this);
    }

    updateProgress(globalProgress) {
        globalProgress = Math.min(100, Math.max(0, globalProgress));

        // Progress updates are asynchronous (via UDP)
        // so things could be out of order. We ignore all progress
        // updates that are lower than what we might have previously received.
        if (globalProgress >= this.progress) {
            this.progress = globalProgress;
        }
    }

    getProjectFolderPath() {
        return path.join(Directories.data, this.uuid);
    }

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

    start(done) {
        const parsedOptions = this.options.reduce((r, c) => {r[c.name] = c.value; return r;}, {});
        const finished = (err) => {

            //TODO: Maybe move this here?
            // const taskOutputFile = path.join(
            //     this.getProjectFolderPath(),
            //     "task_output.txt"
            // );


            // tasks.push(saveTaskOutput(taskOutputFile));

            // tasks.push(done => {
            //     S3.uploadSingle(
            //         taskOutputPath,
            //         taskOutputFile,
            //         (err) => {
            //             done(err);
            //         },
            //         () => { /* we've already saved task output file, no need to write */ }
            //     )
            // });

            this.updateProgress(100);
            this.stopTrackingProcessingTime();
            done(err);
        };

        const tasks = [];

        const saveTaskOutput = (destination) => {
            return (done) => {
                fs.writeFile(destination, this.output.join("\n"), (err) => {
                    if (err)
                        logger.info(
                            `Cannot write log at ${destination}, skipping...`
                        );
                    done();
                });
            };
        };

        let taskOutputPath;

        if (this.status.code === statusCodes.QUEUED) {
            this.startTrackingProcessingTime();
            this.dateStarted = new Date().getTime();
            this.setStatus(statusCodes.RUNNING);

            switch (this.taskType) {
                case 'pointcloud': {
                    const {inputResourceId, outputResourceId, fileName}  = parsedOptions;

                    taskOutputPath = `project/${this.projectId}/resource/potree_pointcloud/${outputResourceId}/task_output.txt`;

                    tasks.push(cb => {
                        this.output.push('downloading pointcloud...')
                        S3.downloadPath(
                            `project/${this.projectId}/resource/pointcloud/${inputResourceId}/${fileName}`,
                            path.join(this.getProjectFolderPath(), fileName),
                            (err) => {
                                if (!err) this.output.push('Done downloading pointcloud, continuing');
                                cb(err);
                            },
                        )
                    });

                    tasks.push(this.runProcess("pointcloud_pre", { fileName }));
                    tasks.push(this.runProcess("pointcloud", { fileName }));


                    tasks.push((cb) => {
                        const potreePointcloudFolderPaths = fs.readdirSync(path.join(this.getProjectFolderPath(), "potree_pointcloud"));

                        S3.uploadPaths(
                            path.join(this.getProjectFolderPath(),"potree_pointcloud"),
                            config.s3Bucket,
                            `project/${this.projectId}/resource/potree_pointcloud/${outputResourceId}`,
                            potreePointcloudFolderPaths,
                            (err) => {
                                if (!err) this.output.push('Done uploading potree_pointcloud, finalizing');
                                cb(err);
                            },
                            (output) => this.output.push(output)
                        )
                    });
                    break;
                }
                case 'orthophoto': {
                    const {inputResourceId} = parsedOptions;

                    taskOutputPath = `project/${this.projectId}/resource/orthophoto/${inputResourceId}/task_output.txt`;

                    tasks.push(cb => {
                        this.output.push('downloading orthophoto...')
                        S3.downloadPath(
                            `project/${this.projectId}/resource/orthophoto/${inputResourceId}/orthophoto-cog.tif`,
                            path.join(this.getProjectFolderPath(), 'orthophoto.tif'),
                            (err) => {
                                if (!err) this.output.push('Done downloading orthophoto, continuing');
                                cb(err);
                            },
                        )
                    });

                    tasks.push(this.runProcess("orthophoto"));

                    tasks.push((cb) => {
                        S3.uploadSingle(
                            `project/${this.projectId}/resource/orthophoto/${inputResourceId}/orthophoto-cog.tif`,
                            path.join(this.getProjectFolderPath(), 'orthophoto-cog.tif'),
                            (err) => {
                                if (!err) this.output.push('Uploaded orthophoto, finalizing');
                                cb(err);
                            },
                            (output) => this.output.push(output)
                        )
                    });

                    break;
                }
                case 'mesh': {
                    const {inputResourceId, outputResourceId} = parsedOptions;

                    taskOutputPath = `project/${this.projectId}/resource/nexus/${outputResourceId}/task_output.txt`;
                    
                    tasks.push(cb => {
                        this.output.push('downloading mesh...')
                        S3.downloadPath(
                            `project/${this.projectId}/resource/mesh/${inputResourceId}/mesh.zip`,
                            path.join(this.getProjectFolderPath(), 'mesh.zip'),
                            (err) => {
                                if (!err) this.output.push('Done downloading mesh, extracting');
                                cb(err);
                            },
                        )
                    });

                    tasks.push(cb => {
                        zipUtils.unzip(
                            path.join(this.getProjectFolderPath(), 'mesh.zip'),
                            path.join(this.getProjectFolderPath(), 'mesh'),
                            (err) => {
                                if (!err) this.output.push('Mesh extracted, processing...');
                                cb(err);
                            },
                        );
                    });

                    tasks.push(this.runProcess("mesh_initial"));
                    tasks.push(this.runProcess("mesh_post"));

                    tasks.push((cb) => {
                        S3.uploadSingle(
                            `project/${this.projectId}/resource/nexus/${outputResourceId}/nexus.nxz`,
                            path.join(this.getProjectFolderPath(), 'nexus.nxz'),
                            (err) => {
                                if (!err) this.output.push('Uploaded mesh, finalizing');
                                cb(err);
                            },
                            (output) => this.output.push(output)
                        )
                    });
                    break;
                }
                case 'sg-compare': {
                    const {prevResourceId, nextResourceId, outputResourceId} = parsedOptions;

                    taskOutputPath = ``; // TODO set this properly

                    // TODO download pointclouds 

                    tasks.push(this.runProcess("sg-compare"))

                    // TODO run potreeconverter 

                    break;
                }
                case 'ifc-convert': {
                    const {inputResourceId, outputResourceId} = parsedOptions; // this might be wrong

                    taskOutputPath = `project/${this.projectId}/resource/ifc-mesh/${outputResourceId}/task_output.txt`;

                    tasks.push(cb => {
                        this.output.push('downloading mesh...')
                        S3.downloadPath(
                            `project/${this.projectId}/resource/bim/${inputResourceId}/bim.ifc`,
                            path.join(this.getProjectFolderPath(), 'bim.ifc'),
                            (err) => {
                                if (!err) this.output.push('Done downloading ifc, continuing');
                                cb(err);
                            },
                        )
                    });
                    tasks.push(this.runProcess("ifc-convert"))
                    tasks.push((cb) => {
                        S3.uploadSingle(
                            `project/${this.projectId}/resource/ifc-mesh/${outputResourceId}/bim.glb`,
                            path.join(this.getProjectFolderPath(), 'bim.glb'),
                            (err) => {
                                if (!err) this.output.push('Uploaded ifc-mesh, finalizing');
                                cb(err);
                            },
                            (output) => this.output.push(output)
                        )
                    });

                    break;
                }
                default:
                    break;
            }

            const taskOutputFile = path.join(
                this.getProjectFolderPath(),
                "task_output.txt"
            );


            tasks.push(saveTaskOutput(taskOutputFile));

            tasks.push(done => {
                S3.uploadSingle(
                    taskOutputPath,
                    taskOutputFile,
                    (err) => {
                        done(err);
                    },
                    () => { /* we've already saved task output file, no need to write */ }
                )
            });

            async.series(tasks, (err) => {
                if (!err) {
                    this.setStatus(statusCodes.COMPLETED);
                    finished();
                } else {
                    this.setStatus(statusCodes.FAILED);
                    finished(err);
                }
            });

            return true;
        } else {
            return false;
        }
    }

    runProcess(type, options) {
        let opts;
        let runner;

        switch (type) {
            case "pointcloud_pre":
                opts = {
                    inputFile: path.join(this.getProjectFolderPath(), options.fileName)
                };
                runner = processRunner.runFixBB;
                break;
            case "pointcloud":
                opts = {
                    input: path.join(this.getProjectFolderPath(), options.fileName),
                    outDir: path.join(this.getProjectFolderPath(), "potree_pointcloud")
                };
                runner = processRunner.runPotreeConverter;
                break;
            case "orthophoto":
                opts = {
                    inputPath: path.join(this.getProjectFolderPath(), "orthophoto.tif"),
                    outputPath: path.join(this.getProjectFolderPath(), "orthophoto-cog.tif")
                };
                runner = processRunner.runGenerateCog;
                break;
            case "mesh_initial":
                opts = {
                    inputOBJFile: path.join(this.getProjectFolderPath(), "mesh", "mesh.obj"),
                    inputMTLFile: path.join(this.getProjectFolderPath(), "mesh", "mesh.mtl"),
                    outputFile: path.join(this.getProjectFolderPath(), "nexus.nxs")
                };
                runner = processRunner.runNxsBuild;
                break;
            case "mesh_post":
                opts = {
                    inputFile: path.join(this.getProjectFolderPath(), "nexus.nxs"),
                    outputFile: path.join(this.getProjectFolderPath(), "nexus.nxz")
                };
                runner = processRunner.runNxsCompress;
                break;
            case "ifc-convert":
                opts= {
                    inputFile: path.join(this.getProjectFolderPath(), "bim.ifc"),
                    outputFile: path.join(this.getProjectFolderPath(), "bim.glb")
                }
                runner = processRunner.runIfcConverter;
                break;
            case "sg-compare":
                // TODO here
                return (done) => done();
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
            projectId: this.projectId,
            name: this.name,
            options: this.options,
            dateCreated: this.dateCreated,
            processingTime: this.processingTime,
            status: this.status,
            taskType: this.taskType,
            progress: this.progress,
        };
    }

    // Returns the output of the OpenDroneMap process
    // Optionally starting from a certain line number
    getOutput(startFromLine = 0) {
        return this.output.slice(startFromLine, this.output.length);
    }

    callWebhooks() {
        // Hooks can be passed via command line
        // or for each individual task
        // const hooks = [this.webhook, config.webhook];
        const hooks = [this.webhook];
        let json = this.getInfo();

        hooks.forEach((hook) => {
            if (hook && hook.length > 3) {
                const notifyCallback = (attempt) => {
                    if (attempt > 5) {
                        logger.warn(
                            `Webhook invokation failed, will not retry: ${hook}`
                        );
                        return;
                    }
                    request.put(hook, {json}, (error, response) => {
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
            options: this.options,
            dateCreated: this.dateCreated,
            dateStarted: this.dateStarted,
            status: this.status,
            taskType: this.taskType,
            webhook: this.webhook,
            output: this.output
        };
    }

    static CreateFromSerialized(taskJson, done) {
        new SingularTask(
            taskJson.uuid,
            taskJson.projectId,
            taskJson.name,
            taskJson.options,
            taskJson.webhook,
            taskJson.taskType,
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

}

