const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const YAML = require('yaml');

function execute() {
    const projectFolderPath = process.argv[2];
    const opensfmFolderPath = path.join(projectFolderPath, 'opensfm');
    const configPath = path.join(opensfmFolderPath, 'config.yaml');

    const configString = fs.readFileSync(configPath, {encoding: 'utf8'});
    const osfmConfig = YAML.parse(configString);

    if (!osfmConfig['bundle_use_gcp']) {
        osfmConfig['bundle_use_gcp'] = true;
    }

    osfmConfig['bundle_use_gps'] = false;

    fs.writeFileSync(configPath, YAML.stringify(osfmConfig));

    const childProcess = spawn('/code/SuperBuild/install/bin/opensfm/bin/opensfm', ['bundle', opensfmFolderPath]);

    childProcess
        .on('exit', (code, signal) => {
            if (signal) {
                return console.error(`terminated with signal:${signal}`);
            }
            console.log(`completed with code ${code}`);
        })
        .on('error', (err) => {
            return console.error(err);
        });

    childProcess.stdout.on('data', data => { console.log(data.toString()) });
    childProcess.stderr.on('data', data => { console.log(data.toString()) });
}

execute();
