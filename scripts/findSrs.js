const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

function extractRootEpsg(wkt) {
    if (!wkt) return null;
    const matches = Array.from(wkt.matchAll(/AUTHORITY\["EPSG","(\d+)"\]/g));
    return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

function resolveProjection(srs, inputFile) {
    let wkt = srs.wkt || '';
    let epsg = extractRootEpsg(wkt);

    // If WKT already has a named projection and isn't "unknown", return it
    if (wkt && !wkt.includes('PROJCS["unknown"') && !wkt.includes('PROJCRS["unknown"')) {
        return { wkt, epsg };
    }

    const projectDir = path.dirname(path.dirname(inputFile));

    // 1. Check if orthophoto exists in the project directory (it has the full EPSG/WKT)
    const orthophotoPaths = [
        path.join(projectDir, 'odm_orthophoto', 'odm_orthophoto.tif'),
        path.join(projectDir, 'odm_orthophoto', 'odm_orthophoto-cog.tif'),
        path.join(projectDir, 'orthophoto.tif')
    ];
    for (const orthoPath of orthophotoPaths) {
        if (fs.existsSync(orthoPath)) {
            try {
                const orthoWkt = execSync(`gdalsrsinfo -o wkt1 "${orthoPath}"`, { encoding: 'utf8' }).trim();
                if (orthoWkt && !orthoWkt.includes('PROJCS["unknown"')) {
                    return { wkt: orthoWkt, epsg: extractRootEpsg(orthoWkt) };
                }
            } catch (e) {}
        }
    }

    // 2. Derive from proj4 if UTM (e.g. +proj=utm +zone=36 +datum=WGS84)
    const proj4Str = srs.proj4 || '';
    const utmMatch = proj4Str.match(/\+proj=utm\s+.*?\+zone=(\d+)/) || proj4Str.match(/\+zone=(\d+).*?\+proj=utm/);
    if (utmMatch) {
        const zone = parseInt(utmMatch[1], 10);
        const isSouth = /\+south\b/.test(proj4Str);
        const derivedEpsg = String(isSouth ? (32700 + zone) : (32600 + zone));
        try {
            const utmWkt = execSync(`gdalsrsinfo -o wkt1 EPSG:${derivedEpsg}`, { encoding: 'utf8' }).trim();
            if (utmWkt && !utmWkt.includes('PROJCS["unknown"')) {
                return { wkt: utmWkt, epsg: derivedEpsg };
            }
        } catch (e) {}
    }

    // 3. Fallback: try GDAL FindMatches via python
    if (proj4Str) {
        try {
            const pyCmd = `python3 -c "from osgeo import osr; s = osr.SpatialReference(); s.SetFromUserInput('''${proj4Str}'''); m = s.FindMatches(); print((m[0][0].ExportToWkt() + '|||' + (m[0][0].GetAuthorityCode(None) or '')) if m else '')" 2>/dev/null`;
            const out = execSync(pyCmd, { encoding: 'utf8' }).trim();
            if (out && out.includes('|||')) {
                const [matchedWkt, matchedEpsg] = out.split('|||');
                if (matchedWkt && !matchedWkt.includes('PROJCS["unknown"')) {
                    return { wkt: matchedWkt, epsg: matchedEpsg || null };
                }
            }
        } catch (e) {}
    }

    return { wkt, epsg };
}

function execute() {
    const inputFile = process.argv[2];
    const targetPath = process.argv[3];

    if (!inputFile || !targetPath) {
        console.error("Usage: node findSrs.js <input.laz> <target_file_or_folder>");
        process.exit(1);
    }

    const childProcess = spawn('pdal', ['info', '--summary', inputFile]);
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

            const srs = parsed.summary && parsed.summary.srs;
            if (!srs || !srs.wkt) {
                return console.error('cannot find wkt');
            }

            const { wkt, epsg } = resolveProjection(srs, inputFile);

            // Determine target files to update
            let targets = [];
            if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
                const eptPath = path.join(targetPath, 'ept.json');
                const metaPath = path.join(targetPath, 'metadata.json');
                if (fs.existsSync(eptPath)) targets.push(eptPath);
                if (fs.existsSync(metaPath)) targets.push(metaPath);
            } else {
                targets.push(targetPath);
                // Also check sibling ept.json / metadata.json if path was specific
                const dir = path.dirname(targetPath);
                const base = path.basename(targetPath);
                if (base === 'metadata.json') {
                    const siblingEpt = path.join(dir, '..', 'entwine_pointcloud', 'ept.json');
                    if (fs.existsSync(siblingEpt)) targets.push(siblingEpt);
                } else if (base === 'ept.json') {
                    const siblingMeta = path.join(dir, '..', 'potree_pointcloud', 'metadata.json');
                    if (fs.existsSync(siblingMeta)) targets.push(siblingMeta);
                }
            }

            for (const file of targets) {
                try {
                    if (!fs.existsSync(file)) continue;
                    const content = fs.readFileSync(file, 'utf8');
                    let json = JSON.parse(content);

                    // Add top-level projection (read by Potree and sg-pointcloud.js)
                    json.projection = wkt;

                    // If ept.json, also update srs structure for EptLoader
                    if (file.endsWith('ept.json') || json.dataType) {
                        json.srs = json.srs || {};
                        json.srs.wkt = wkt;
                        // Do not set horizontal/authority in srs because Potree sets this.projection = authority + ":" + horizontal
                        // and tests proj4(this.projection), which fails and nulls it out if proj4 lacks the EPSG definition.
                        delete json.srs.authority;
                        delete json.srs.horizontal;
                        if (srs.compoundwkt) json.srs.compoundwkt = srs.compoundwkt;
                        if (srs.proj4) json.srs.proj4 = srs.proj4;
                    }

                    fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf8');
                    console.log(`Successfully updated projection in ${file} (EPSG: ${epsg || 'none'})`);
                } catch (err) {
                    console.error(`Error updating ${file}:`, err);
                }
            }

            console.log(`completed with code ${code}`);
        })
        .on('error', (err) => {
            return console.error(err);
        });

    childProcess.stdout.on('data', data => { stdout += data });
    childProcess.stderr.on('data', data => { stderr += data });
}

execute();
