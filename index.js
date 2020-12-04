'use strict';

/**
 * This file declares a plugin for the Serverless framework.
 *
 * This lets us define variables and helpers to simplify creating PHP applications.
 */

class ServerlessPlugin {
    constructor(serverless, options) {
        this.serverless = serverless;
        this.options = options;
        this.provider = this.serverless.getProvider('aws');

        this.fs = require('fs');
        const path = require('path');
        const filename = path.resolve(__dirname, 'layers.json');
        const layers = JSON.parse(this.fs.readFileSync(filename));

        this.checkCompatibleRuntime();

        // Override the variable resolver to declare our own variables
        const delegate = this.serverless.variables
            .getValueFromSource.bind(this.serverless.variables);
        this.serverless.variables.getValueFromSource = (variableString) => {
            if (variableString.startsWith('bref:layer.')) {
                const region = this.provider.getRegion();
                const layerName = variableString.substr('bref:layer.'.length);
                if (! (layerName in layers)) {
                    throw `Unknown Bref layer named "${layerName}"`;
                }
                if (! (region in layers[layerName])) {
                    throw `There is no Bref layer named "${layerName}" in region "${region}"`;
                }
                const version = layers[layerName][region];
                return `arn:aws:lambda:${region}:209497400698:layer:${layerName}:${version}`;
            }

            return delegate(variableString);
        }

        this.hooks = {
            'before:deploy:deploy': this.createVendorZip.bind(this)
        };
    }

    checkCompatibleRuntime() {
        if (this.serverless.service.provider.runtime === 'provided') {
            throw new Error('Bref 1.0 layers are not compatible with the "provided" runtime. To upgrade to Bref 1.0, you have to switch to "provided.al2" in serverless.yml. More details here: https://bref.sh/docs/news/01-bref-1.0.html#amazon-linux-2');
        }
        for (const [name, f] of Object.entries(this.serverless.service.functions)) {
            if (f.runtime === 'provided') {
                throw new Error(`Bref 1.0 layers are not compatible with the "provided" runtime. To upgrade to Bref 1.0, you have to switch to "provided.al2" in serverless.yml for the function "${name}". More details here: https://bref.sh/docs/news/01-bref-1.0.html#amazon-linux-2`);
            }
        }
    }

    async createVendorZip() {
        if(! this.serverless.service.provider.custom.separateVendor) {
            return;
        }

        const vendorZipHash = this.createZipFile();
        const newVendorZipName = vendorZipHash + '.zip';

        this.fs.renameSync('vendor.zip', newVendorZipName);

        this.uploadZipToS3(newVendorZipName).then(() => {
            this.serverless.service.package.exclude.push('vendor/**');
            this.serverless.service.provider.environment.BREF_DOWNLOAD_VENDOR = true;
            this.serverless.service.provider.environment.BREF_VENDOR_BUCKET = this.serverless.provider.deploymentBucket.name;
            this.serverless.service.provider.environment.BREF_VENDOR_FILE = this.serverless.provider.deploymentPrefix + '/' + newVendorZipName;
        }).catch((err) => {
            throw new Error(`Failed to upload vendor file "${newVendorZipName}" to s3 bucket: ${err.message}`);
        });
    }

    async createZipFile() {
        const admZip = require('adm-zip');
        const zip = new admZip();

        zip.addLocalFolder('vendor/', '');

        zip.writeZip('vendor.zip');

        return await this.createHashFromFile('vendor.zip');
    }

    // Following code is from here: https://gist.github.com/GuillermoPena/9233069#gistcomment-3108307
    createHashFromFile(filePath) {
        const crypto = require('crypto');

        return new Promise(resolve => {
            const hash = crypto.createHash('sha256');
            this.fs.createReadStream(filePath).on('data', data => hash.update(data)).on('end', () => resolve(hash.digest('hex')));
        });
    }

    async uploadZipToS3(zipFile) {
        const bucketObjects = await this.provider.request('S3', 'listObjectsV2', {
            Bucket: this.serverless.provider.deploymentBucket.name,
            Prefix: this.serverless.provider.deploymentPrefix
        });

        if (bucketObjects.Contents.length === 0) {
            return true;
        }

        if(bucketObjects.indexOf(zipFile) >= 0) {
            return true;
        }

        const body = this.fs.readFileSync(zipFile);

        const details = {
            ACL: 'private',
            Body: body,
            Bucket: this.serverless.provider.deploymentBucket,
            ContentType: 'application/zip',
            Key: zipFile,
        };

        return await this.provider.request('S3', 'putObject', details);
    }
}

module.exports = ServerlessPlugin;
