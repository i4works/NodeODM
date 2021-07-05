module.exports = class AbstractTask {
    // Must have fields (to be compatible with TaskManger)
    // uuid
    // status
    // dateStarted
    // processingTime
    constructor() {

    }

    start () {
        throw new Error("start method should be implemented");
    }

    updateProgress () {
        throw new Error("updateProgress method should be implemented");
    }

    cancel () {
        throw new Error("cancel method should be implemented");
    }

    isCanceled () {
        throw new Error("isCanceled method should be implemented");
    }

    restart () {
        throw new Error("restart method should be implemented");
    }

    isRunning () {
        throw new Error("isRunning method should be implemented");
    }

    callWebhooks () {
        throw new Error("callWebhooks method should be implemented");
    }

    cleanup () {
        throw new Error("cleanup method should be implemented");
    }

    serialize () {
        throw new Error("serialize method should be implemented");
    }

    static CreateFromSerialized () {
        throw new Error("static CreateFromSerialized method should be implemented");
    }

}
