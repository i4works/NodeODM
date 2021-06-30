const async = require("async");
const kill = require("tree-kill");

const AbstractTask = require("./AbstractTask");
const processRunner = require("./processRunner");
const Directories = require("./Directories");
const S3 = require("./S3");

const statusCodes = require('./statusCodes');

module.exports = class SingularTask extends AbstractTask {
    constructor(
        uuid,
        projectId,
        inputs,
        name,
        options = [],
        webhook = null,
        taskType,
        dateCreated = new Date().getTime(),
        done = () => {}        
    ) {
        super();
        assert(projectId !== undefined, 'projectId must be set');
        assert(uuid !== undefined, "uuid must be set");
        assert(done !== undefined, "ready must be set");
        assert(taskType !== undefined, "taskType must be set");
        assert(inputs !== undefined, 'inputs must be set');
        // TODO check if taskType matches input type

        this.uuid = uuid;
        this.projectId = projectId;
        this.resourceId = inputs;
        this.name = name !== "" ? name : "Task of " + new Date().toISOString();
        this.dateCreated = isNaN(parseInt(dateCreated))
            ? new Date().getTime()
            : parseInt(dateCreated);
        this.dateStarted = 0;
        this.processingTime = -1;
        this.progress = 0;
        this.runningProcesses = [];
        this.output = [];
        this.setStatus(statusCodes.QUEUED);
    }

    updateProgress () {
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
        const finished = (err) => {
            this.updateProgress(100);
            this.stopTrackingProcessingTime();
            done(err);
        };

        const tasks = [];

        if (this.status.code === statusCodes.QUEUED) {
            this.startTrackingProcessingTime();
            this.dateStarted = new Date().getTime();
            this.setStatus(statusCodes.RUNNING);

            switch (this.taskType) {
                case 'pointcloud': 
                    const { inputResourceId, outputResourceId } = this.inputs;
                    // TODO download pointcloud.laz

                    tasks.push(this.runProcess('pointcloud_pre'));
                    tasks.push(this.runProcess('pointcloud'));

                    break;
                case 'orthophoto': 
                    const { inputResourceId, outputResourceId } = this.inputs;
                    // TODO download orthophoto.tif

                    tasks.push(this.runProcess('orthophoto'));
                    break;
                case 'mesh':
                    const { inputResouceId, outputResourceId } = this.inputs;
                    // TODO download mesh zip or individual files

                    tasks.push(this.runProcess('mesh_initial'));
                    tasks.push(this.runProcess('mesh_post'));
                    break;
                case 'sg-compare':
                    const { prevResourceId, nextResourceId, outputResourceId } = this.inputs;
                    // TODO download pointclouds 

                    tasks.push(this.runProcess('sg-compare'))

                    break;
                case 'ifc-convert':
                    const { inputResourceId, outputResourceId } = this.inputs; // this might be wrong
                    // TODO download ifc file
                    tasks.push(this.runProcess('ifc-convert'))

                    break;
                default:
                    break;
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

            return true;
        } else {
            return false;
        }
    }

    runProcess (type) {
        let opts;
        let runner;

        switch (type) {
            case 'pointcloud_pre':
                opts = {
                    inputFile: path.join(this.getProjectFolderPath(),'pointcloud.laz')
                };
                runner = processRunner.runFixBB;
                break;
            case 'pointcloud':
                opts = {
                    input: path.join(this.getProjectFolderPath(), 'pointcloud.laz'),
                    outDir: path.join(this.getProjectFolderPath(), 'potree_pointcloud')
                };
                runner = processRunner.runPotreeConverter;
                break;
            case 'orthophoto':
                opts = {
                    inputPath: path.join(this.getProjectFolderPath(), 'orthophoto.tif'),
                    outputPath: path.join(this.getProjectFolderPath(), 'orthophoto-cog.tif')
                };
                runner = processRunner.runGenerateCog;
                break;
            case 'mesh_initial':
                opts = {
                    inputOBJFile: path.join(this.getProjectFolderPath(), 'mesh.obj'),
                    inputMTLFile: path.join(this.getProjectFolderPath(), 'mesh.mtl'),
                    outputFile: path.join(this.getProjectFolderPath(), 'nexus.nxs')
                };
                runner = processRunner.runNxsBuild;
                break;
            case 'mesh_post':
                opts = {
                    inputFile: path.join(this.getProjectFolderPath(), 'nexus.nxs'),
                    outputFile: path.join(this.getProjectFolderPath(), 'nexus.nxz')
                };
                runner = processRunner.runNxsCompress;
                break;
            case 'ifc-convert':
                // TODO here
                return (done) => done();
                break;
            case 'sg-compare':
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
            inputs: this.inputs,
            dateCreated: this.dateCreated,
            processingTime: this.processingTime,
            status: this.status,
            options: this.options,
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
        const hooks = [this.webhook, config.webhook];

        this.readImagesDatabase((err, images) => {
            if (err) logger.warn(err); // Continue with callback
            if (!images) images = [];

            let json = this.getInfo();
            json.images = images;

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
        });
    }

    // Returns the data necessary to serialize this
    // task to restore it later.
    serialize() {
        return {
            uuid: this.uuid,
            projectId: this.projectId,
            name: this.name,
            inputs: this.inputs,
            dateCreated: this.dateCreated,
            dateStarted: this.dateStarted,
            status: this.status,
            taskType: this.taskType,
            options: this.options,
            webhook: this.webhook,
        };
    }

    static CreateFromSerialized(taskJson, done) {
        new SingularTask(
            taskJson.uuid,
            taskJson.projectId,
            taskJson.inputs,
            taskJson.name,
            taskJson.options,
            taskJson.taskType,
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

