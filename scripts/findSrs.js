const fs = require('fs');
const { spawn } = require('child_process');

const childProcess = spawn('pdal', ['info', '--summary', process.argv[2]]);

function execute() {
    let stdout = '';
    let stderr = '';

    childProcess
        .on('exit', (code, signal) => {
            if (signal) {
                return console.error(`terminated with signal:${signal}`);
            }

            let parsed;
            try {
                parsed = JSON.parse(stdout);
            } catch (e) {
                return console.error(`cannot parse JSON: ${e}`);
            }

            if (!parsed.summary.srs || !parsed.summary.srs.wkt) {
                return console.error('cannot find wkt');
            }

            const wkt = parsed.summary.srs.wkt;
            
            // write coord into metadata.json
            fs.readFile(process.argv[3], 'utf8', (err, data) => {
                if (err) return console.error(err);

                const result = data.replace(`"projection": ""`, `"projection": "${wkt}"`);

                fs.writeFile(process.argv[3], result, 'utf8', err => {
                    if (err) return console.error(err);

                    console.log(`completed with code ${code}`);
                });
            });

        })
        .on('error', (err) => {
            return console.error(err);
        });

    childProcess.stdout.on('data', data => { stdout += data });
    childProcess.stderr.on('data', data => { stderr += data });
}

execute();
