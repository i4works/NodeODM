/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
'use strict';

let fs = require('fs');
let argv = require('minimist')(process.argv.slice(2));
let utils = require('./libs/utils');
let apps = require('./libs/apps');
const spawnSync = require('child_process').spawnSync;

if (argv.help){
	console.log(`
Usage: node index.js [options]

Options:
	--config <path>	Path to the configuration file (default: config-default.json)	
	-p, --port <number> 	Port to bind the server to, or "auto" to automatically find an available port (default: 3000)
	--odm_path <path>	Path to ODM's code	(default: /code)
	--log_level <logLevel>	Set log level verbosity (default: info)
	-d, --daemon 	Set process to run as a deamon
	-q, --parallel_queue_processing <number> Number of simultaneous processing tasks (default: 1)
	--cleanup_tasks_after <number> Number of minutes that elapse before deleting finished and canceled tasks (default: 2880) 
	--cleanup_uploads_after <number> Number of minutes that elapse before deleting unfinished uploads. Set this value to the maximum time you expect a dataset to be uploaded. (default: 2880) 
	--test Enable test mode. In test mode, no commands are sent to ODM. This can be useful during development or testing (default: false)
	--test_skip_orthophotos	If test mode is enabled, skip orthophoto results when generating assets. (default: false) 
	--test_skip_dems	If test mode is enabled, skip dems results when generating assets. (default: false) 
	--test_drop_uploads	If test mode is enabled, drop /task/new/upload requests with 50% probability. (default: false)
	--test_fail_tasks	If test mode is enabled, mark tasks as failed. (default: false)
	--test_seconds	If test mode is enabled, sleep these many seconds before finishing processing a test task. (default: 0)
	--powercycle	When set, the application exits immediately after powering up. Useful for testing launch and compilation issues.
	--token <token>	Sets a token that needs to be passed for every request. This can be used to limit access to the node only to token holders. (default: none)
	--max_images <number>	Specify the maximum number of images that this processing node supports. (default: unlimited)
	--webhook <url>	Specify a POST URL endpoint to be invoked when a task completes processing (default: none)
	--s3_endpoint <url>	Specify a S3 endpoint (for example, nyc3.digitaloceanspaces.com) to upload completed task results to. (default: do not upload to S3)
	--s3_bucket <bucket>	Specify a S3 bucket name where to upload completed task results to. (default: none)
	--s3_access_key <key>	S3 access key, required if --s3_endpoint is set. (default: none)
	--s3_force_path_style  Whether to force path style URLs for S3 objects. (default: false)
	--s3_secret_key <secret>	S3 secret key, required if --s3_endpoint is set. (default: none) 
	--s3_signature_version <version>	S3 signature version. (default: 4)
	--s3_acl <canned-acl> S3 object acl. Can specify "none" to skip. (default: public-read)
	--s3_upload_everything	Upload all task results to S3. (default: upload only all.zip archive)
	--s3_ignore_ssl Whether to ignore SSL errors while connecting to S3. (default: false)
	--max_concurrency   <number>	Place a cap on the max-concurrency option to use for each task. (default: no limit)
	--max_runtime	<number> Number of minutes (approximate) that a task is allowed to run before being forcibly canceled (timeout). (default: no limit)
Log Levels: 
error | warn | info | verbose | debug | silly 
`);
	process.exit(0);
}

const allOpts = ["slice","help","config","odm_path","log_level","port","p",
"deamonize","daemon","d","parallel_queue_processing","q",
"cleanup_tasks_after","cleanup_uploads_after","test","test_skip_orthophotos",
"test_skip_dems","test_drop_uploads","test_fail_tasks","test_seconds",
"powercycle","token","max_images","webhook","s3_endpoint","s3_bucket",
"s3_force_path_style","s3_access_key","s3_secret_key","s3_signature_version",
"s3_acl","s3_upload_everything","s3_ignore_ssl","max_concurrency","max_runtime"];

// Support for "-" or "_" style params syntax
for (let k in argv){
    if (k === "_") continue;
    
    const opt = k.replace(/-/g, "_");
    argv[opt] = argv[k];
    if (allOpts.indexOf(opt) === -1){
        console.log(`warning: Unrecognized flag ${k}`);
    }
}

let config = {};

// Read configuration from file
let configFilePath = argv.config || "config-default.json";
let configFile = {};

if (/\.json$/i.test(configFilePath)){
	try{
		let data = fs.readFileSync(configFilePath);
		configFile = JSON.parse(data.toString());
	}catch(e){
		console.log(`Invalid configuration file ${configFilePath}`);
		process.exit(1);
	}
}

// Gets a property that might not exist from configuration file
// example: fromConfigFile("logger.maxFileSize", 1000);
function fromConfigFile(prop, defaultValue){
	return utils.get(configFile, prop, defaultValue);
}

function fromEnv(name){
	const val = process.env[name];
	return (val !== undefined && val !== "") ? val : undefined;
}

function fromEnvBool(name){
	const val = fromEnv(name);
	if (val === undefined) return undefined;
	const lower = val.trim().toLowerCase();
	if (lower === "true" || lower === "1" || lower === "yes") return true;
	if (lower === "false" || lower === "0" || lower === "no") return false;
	return undefined;
}

function fromEnvInt(name){
	const val = fromEnv(name);
	if (val === undefined) return undefined;
	const parsed = parseInt(val, 10);
	return isNaN(parsed) ? undefined : parsed;
}

function fromEnvList(name){
	const val = fromEnv(name);
	if (val === undefined) return undefined;
	return val.split(",").map(s => s.trim()).filter(Boolean);
}

function firstDefined(){
	for (let i = 0; i < arguments.length; i++){
		if (arguments[i] !== undefined) return arguments[i];
	}
	return undefined;
}

// Instance name - default name for this configuration
config.instance = firstDefined(fromEnv("INSTANCE"), fromConfigFile("instance", 'node-OpenDroneMap'));
config.odm_path = firstDefined(argv.odm_path, fromEnv("ODM_PATH"), fromConfigFile("odm_path", '/code'));

// Logging configuration
config.logger = {};
config.logger.level = firstDefined(argv.log_level, fromEnv("LOG_LEVEL"), fromConfigFile("logger.level", 'info')); // What level to log at; info, verbose or debug are most useful. Levels are (npm defaults): silly, debug, verbose, info, warn, error.
config.logger.maxFileSize = firstDefined(fromEnvInt("LOG_MAX_FILE_SIZE"), fromConfigFile("logger.maxFileSize", 1024 * 1024 * 100)); // Max file size in bytes of each log file; default 100MB
config.logger.maxFiles = firstDefined(fromEnvInt("LOG_MAX_FILES"), fromConfigFile("logger.maxFiles", 10)); // Max number of log files kept
config.logger.logDirectory = firstDefined(fromEnv("LOG_DIRECTORY"), fromConfigFile("logger.logDirectory", '')); // Set this to a full path to a directory - if not set logs will be written to the application directory.

config.port = firstDefined(argv.port, argv.p, fromEnv("PORT"), fromConfigFile("port", "auto"));
config.deamon = firstDefined(argv.deamonize, argv.daemon, argv.d, fromEnvBool("DAEMON"), fromConfigFile("daemon", false));
config.parallelQueueProcessing = parseInt(firstDefined(argv.parallel_queue_processing, argv.q, fromEnvInt("PARALLEL_QUEUE_PROCESSING"), fromConfigFile("parallelQueueProcessing", 1)));
config.cleanupTasksAfter = parseInt(firstDefined(argv.cleanup_tasks_after, fromEnvInt("CLEANUP_TASKS_AFTER"), fromConfigFile("cleanupTasksAfter", 2880)));
config.cleanupUploadsAfter = parseInt(firstDefined(argv.cleanup_uploads_after, fromEnvInt("CLEANUP_UPLOADS_AFTER"), fromConfigFile("cleanupUploadsAfter", 2880)));
config.test = firstDefined(argv.test, fromEnvBool("TEST"), fromConfigFile("test", false));
config.testSkipOrthophotos = firstDefined(argv.test_skip_orthophotos, fromEnvBool("TEST_SKIP_ORTHOPHOTOS"), fromConfigFile("testSkipOrthophotos", false));
config.testSkipDems = firstDefined(argv.test_skip_dems, fromEnvBool("TEST_SKIP_DEMS"), fromConfigFile("testSkipDems", false));
config.testDropUploads = firstDefined(argv.test_drop_uploads, fromEnvBool("TEST_DROP_UPLOADS"), fromConfigFile("testDropUploads", false));
config.testFailTasks = firstDefined(argv.test_fail_tasks, fromEnvBool("TEST_FAIL_TASKS"), fromConfigFile("testFailTasks", false));
config.testSeconds = parseInt(firstDefined(argv.test_seconds, fromEnvInt("TEST_SECONDS"), fromConfigFile("testSeconds", 0)));
config.powercycle = firstDefined(argv.powercycle, fromEnvBool("POWERCYCLE"), fromConfigFile("powercycle", false));
config.token = firstDefined(argv.token, fromEnv("TOKEN"), fromConfigFile("token", ""));
config.authorizedIps = firstDefined(fromEnvList("AUTHORIZED_IPS"), fromConfigFile("authorizedIps", []));
config.maxImages = parseInt(firstDefined(argv.max_images, fromEnvInt("MAX_IMAGES"), fromConfigFile("maxImages", ""))) || null;
config.webhook = firstDefined(argv.webhook, fromEnv("WEBHOOK"), fromConfigFile("webhook", ""));
config.s3Endpoint = firstDefined(argv.s3_endpoint, fromEnv("S3_ENDPOINT"), fromConfigFile("s3Endpoint", ""));
config.s3Bucket = firstDefined(argv.s3_bucket, fromEnv("S3_BUCKET"), fromConfigFile("s3Bucket", ""));
config.s3ForcePathStyle = firstDefined(argv.s3_force_path_style, fromEnvBool("S3_FORCE_PATH_STYLE"), fromConfigFile("s3ForcePathStyle", false));
config.s3AccessKey = firstDefined(argv.s3_access_key, fromEnv("S3_ACCESS_KEY"), fromEnv("AWS_ACCESS_KEY_ID"), fromConfigFile("s3AccessKey", ""));
config.s3SecretKey = firstDefined(argv.s3_secret_key, fromEnv("S3_SECRET_KEY"), fromEnv("AWS_SECRET_ACCESS_KEY"), fromConfigFile("s3SecretKey", ""));
config.s3SignatureVersion = firstDefined(argv.s3_signature_version, fromEnv("S3_SIGNATURE_VERSION"), fromConfigFile("s3SignatureVersion", "4"));
config.s3ACL = firstDefined(argv.s3_acl, fromEnv("S3_ACL"), fromConfigFile("s3_acl", "public-read"));
config.s3UploadEverything = firstDefined(argv.s3_upload_everything, fromEnvBool("S3_UPLOAD_EVERYTHING"), fromConfigFile("s3UploadEverything", false));
config.s3IgnoreSSL = firstDefined(argv.s3_ignore_ssl, fromEnvBool("S3_IGNORE_SSL"), fromConfigFile("s3IgnoreSSL", false));
config.maxConcurrency = parseInt(firstDefined(argv.max_concurrency, fromEnvInt("MAX_CONCURRENCY"), fromConfigFile("maxConcurrency", 0)));
config.maxRuntime = parseInt(firstDefined(argv.max_runtime, fromEnvInt("MAX_RUNTIME"), fromConfigFile("maxRuntime", -1)));

// Detect 7z availability
config.has7z = spawnSync(apps.sevenZ, ['--help']).status === 0;
config.hasUnzip = spawnSync(apps.unzip, ['--help']).status === 0;


module.exports = config;
