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
        this.path = require('path');
        const filename = this.path.resolve(__dirname, 'layers.json');
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
            //'before:deploy:deploy': this.createVendorZip.bind(this)
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

        this.bucketName = await this.provider.getServerlessDeploymentBucketName();
        this.deploymentPrefix = await this.provider.getDeploymentPrefix();

        const vendorZipHash = await this.createZipFile();
        const newVendorZipName = vendorZipHash + '.zip';

        this.fs.renameSync('vendor.zip', newVendorZipName);

        await this.uploadZipToS3(newVendorZipName);

        console.log('Bref: Setting environment variables.');

        let filePath = this.stripSlashes((this.deploymentPrefix || '') + '/vendors/' + newVendorZipName);

        let excludes = this.serverless.service.package.exclude;
        if(excludes.indexOf('vendor/**') === -1) {
            excludes[excludes.length] = 'vendor/**';
        }

        excludes[excludes.length] = newVendorZipName;

        this.serverless.service.provider.environment.BREF_DOWNLOAD_VENDOR = `s3://${this.bucketName}/${filePath}`;

        let iamRoleStatements = this.serverless.service.provider.iamRoleStatements;
        const roleDetails = {
            'Effect': 'Allow',
            'Action': 's3:GetObject',
            'Resource': [
                `${this.bucketName}/vendors/*`
            ]
        };

        if(typeof iamRoleStatements !== 'undefined' && iamRoleStatements) {
            if(iamRoleStatements.indexOf(roleDetails) === -1) {
                iamRoleStatements[iamRoleStatements.length] = roleDetails;
            }
        } else {
            this.serverless.service.provider.iamRoleStatements = [
                roleDetails
            ];
        }

        console.log(this.serverless.service.provider.environment);

        console.log('Bref: Vendor separation done!');
    }

    async createZipFile() {
        const filePath = 'vendor.zip';

        return await new Promise((resolve, reject) => {
            const archiver = require(process.mainModule.path + '/../node_modules/archiver');
            const output = this.fs.createWriteStream(filePath);
            const archive = archiver('zip', {
                zlib: { level: 9 } // Sets the compression level.
            });

            console.log(`Bref: Creating ${filePath} archive...`);

            archive.pipe(output);
            archive.directory('vendor/', false);
            archive.finalize();

            output.on('close', () => {
                console.log(`Bref: Created ${filePath} with ${archive.pointer()} total bytes.`);
                resolve();
            });

            output.on('end', () => {
                console.log('Bref: Archiver data stream has been drained');
            });

            archive.on('warning', err => {
                if (err.code === 'ENOENT') {
                    // log warning
                    console.warn('Bref: Archiver warning', err);
                } else {
                    // throw error
                    console.error('Bref: Archiver warning', err);
                    reject(err);
                }
            });

            archive.on('error', err => {
                console.error('Bref: Archiver error', err);
                reject(err);
            });
        })
            .then(() => {
                const crypto = require('crypto');

                return new Promise(resolve => {
                    const hash = crypto.createHash('md5');
                    this.fs.createReadStream(filePath).on('data', data => hash.update(data)).on('end', () => resolve(hash.digest('hex')));
                });
            })
            .then(hash => {
                return hash;
            })
            .catch(err => {
                throw new Error(`Failed to create zip file "${filePath}": ${err.message}`);
            });
    }

    async uploadZipToS3(zipFile) {
        const bucketObjects = await this.provider.request('S3', 'listObjectsV2', {
            Bucket: this.bucketName,
            Prefix: this.deploymentPrefix || ''
        })

        console.log('Bref: Checking vendor file on bucket...');

        const preparedBucketObjects = bucketObjects.Contents.map(object => object.Key);
        console.log(preparedBucketObjects);

        if(preparedBucketObjects.indexOf(this.stripSlashes(this.deploymentPrefix + '/vendors/' + zipFile)) >= 0) {
            console.log('Bref: Vendor file already exists on bucket. Not uploading again.');
            return;
        }

        console.log('Bref: Vendor file not found. Uploading...')

        const readStream = this.fs.createReadStream(zipFile);
        const details = {
            ACL: 'private',
            Body: readStream,
            Bucket: this.bucketName,
            ContentType: 'application/zip',
            Key: this.stripSlashes(this.deploymentPrefix + '/vendors/' + zipFile),
        };

        return await this.provider.request('S3', 'putObject', details);
    }

    stripSlashes(filePath) {
        return filePath.replace(/^\/+/g, '');
    }
}

module.exports = ServerlessPlugin;
