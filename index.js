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
            'package:setupProviderConfiguration': this.createVendorZip.bind(this)
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
        if(! this.serverless.service.custom.separateVendor) {
            return;
        }

        const vendorZipHash = this.createZipFile();
        const newVendorZipName = vendorZipHash + '.zip';

        this.fs.renameSync('vendor.zip', newVendorZipName);

        await this.uploadZipToS3(newVendorZipName);

        let filePath = this.stripSlashes((this.serverless.provider.deploymentPrefix || '') + '/' + newVendorZipName);

        this.serverless.service.package.exclude.push('vendor/**');
        this.serverless.service.provider.environment.BREF_DOWNLOAD_VENDOR = `s3://${this.serverless.provider.deploymentBucket.name}/${filePath}`;
        this.serverless.service.provider.iamRoleStatements.push({
            'Effect': 'Allow',
            'Action': 's3:GetObject',
            'Resource': [
                `${this.serverless.provider.deploymentBucket.name}/*`
            ]
        });
    }

    async createZipFile() {
        const filePath = 'vendor.zip';

        return await new Promise((resolve, reject) => {
            const JSZip = require('../../../node_modules/jszip');
            const zip = new JSZip();

            zip
                .folder('vendor/', '')
                .generateNodeStream({type:'nodebuffer', streamFiles:true})
                .pipe(this.fs.createWriteStream(filePath))
                .on('finish', function () {
                    resolve()
                })
                .on('error', reject);
        })
            .then(() => {
                const crypto = require('crypto');

                return new Promise(resolve => {
                    const hash = crypto.createHash('sha256');
                    this.fs.createReadStream(filePath).on('data', data => hash.update(data)).on('end', () => resolve(hash.digest('hex')));
                });
            })
            .catch(err => {
                throw new Error(`Failed to create zip file "${filePath}": ${err.message}`);
            });
    }

    async uploadZipToS3(zipFile) {
        return await this.provider.request('S3', 'listObjectsV2', {
            Bucket: this.serverless.provider.deploymentBucket.name,
            Prefix: this.serverless.provider.deploymentPrefix || ''
        })
            .then(bucketObjects => {
                return new Promise((resolve, reject) => {
                    if(bucketObjects.indexOf(zipFile) >= 0) {
                        return reject('Vendor file already exists.');
                    }

                    resolve();
                })
            })
            .then(() => this.fs.createReadStream(zipFile))
            .then(body => {
                const details = {
                    ACL: 'private',
                    Body: body,
                    Bucket: this.serverless.provider.deploymentBucket.name,
                    ContentType: 'application/zip',
                    Key: this.stripSlashes(this.serverless.provider.deploymentPrefix + '/' + zipFile),
                };

                return this.provider.request('S3', 'putObject', details);
            })
            .catch(err => {
                throw new Error(`Failed to upload vendor file "${zipFile}" to s3 bucket: ${err.message}`);
            });
    }

    stripSlashes(filePath) {
        return filePath.replace(/^\/+/g, '');
    }
}

module.exports = ServerlessPlugin;
