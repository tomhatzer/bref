<?php declare(strict_types=1);

use Bref\Bref;
use Bref\Runtime\LambdaRuntime;

ini_set('display_errors', '1');
error_reporting(E_ALL);

$appRoot = getenv('LAMBDA_TASK_ROOT');

// From https://gist.github.com/anthonyeden/4448695ad531016ec12bcdacc9d91cb8
function AWS_S3_PresignDownload($AWSAccessKeyId, $AWSSecretAccessKey, $AWSSessionToken, $BucketName, $AWSRegion, $canonical_uri, $expires = 86400) {
    // Creates a signed download link for an AWS S3 file
    // Based on https://gist.github.com/kelvinmo/d78be66c4f36415a6b80

    $encoded_uri = str_replace('%2F', '/', rawurlencode($canonical_uri));

    // Specify the hostname for the S3 endpoint
    if($AWSRegion == 'us-east-1') {
        $hostname = trim($BucketName .".s3.amazonaws.com");
        $header_string = "host:" . $hostname . "\n";
        $signed_headers_string = "host";
    } else {
        $hostname =  trim($BucketName . ".s3-" . $AWSRegion . ".amazonaws.com");
        $header_string = "host:" . $hostname . "\n";
        $signed_headers_string = "host";
    }

    $date_text = gmdate('Ymd', time());
    $time_text = $date_text . 'T000000Z';
    $algorithm = 'AWS4-HMAC-SHA256';
    $scope = $date_text . "/" . $AWSRegion . "/s3/aws4_request";

    $x_amz_params = array(
        'X-Amz-Algorithm' => $algorithm,
        'X-Amz-Credential' => $AWSAccessKeyId . '/' . $scope,
        'X-Amz-Date' => $time_text,
        'X-Amz-SignedHeaders' => $signed_headers_string,
        'X-Amz-Security-Token' => $AWSSessionToken,
    );

    if ($expires > 0) {
        // 'Expires' is the number of seconds until the request becomes invalid
        $x_amz_params['X-Amz-Expires'] = (string)$expires;
    }

    ksort($x_amz_params);

    $query_string = "";
    foreach ($x_amz_params as $key => $value) {
        $query_string .= rawurlencode($key) . '=' . rawurlencode($value) . "&";
    }
    $query_string = substr($query_string, 0, -1);

    $canonical_request = "GET\n" . $encoded_uri . "\n" . $query_string . "\n" . $header_string . "\n" . $signed_headers_string . "\nUNSIGNED-PAYLOAD";
    $string_to_sign = $algorithm . "\n" . $time_text . "\n" . $scope . "\n" . hash('sha256', $canonical_request, false);
    $signing_key = hash_hmac('sha256', 'aws4_request', hash_hmac('sha256', 's3', hash_hmac('sha256', $AWSRegion, hash_hmac('sha256', $date_text, 'AWS4' . $AWSSecretAccessKey, true), true), true), true);
    $signature = hash_hmac('sha256', $string_to_sign, $signing_key);

    return 'https://' . $hostname . $encoded_uri . '?' . $query_string . '&X-Amz-Signature=' . $signature;

}

function downloadVendorArchive(string $s3String, string $downloadPath) {
    preg_match('~s3\:\/\/([^\/]+)\/(.*)~', $s3String, $matches);
    $bucket = $matches[1];
    $filePath = '/' . $matches[2];
    $region = getenv('AWS_REGION');

    $url = AWS_S3_PresignDownload(getenv('AWS_ACCESS_KEY_ID'), getenv('AWS_SECRET_ACCESS_KEY'), getenv('AWS_SESSION_TOKEN'), $bucket, $region, $filePath);

    if(file_exists($downloadPath)) {
        unlink($downloadPath);
    }

    $fp = fopen($downloadPath, 'w');

    $options = [
        CURLOPT_HEADER => 0,
        CURLOPT_FOLLOWLOCATION => 1,
        CURLOPT_FILE => $fp,
    ];

    $ch = curl_init($url);
    curl_setopt_array($ch, $options);
    curl_exec($ch);
    curl_close($ch);
    fclose($fp);
}

function unzipVendorArchive(string $filePath, string $unzipPath): bool {
    $zip = new \ZipArchive();
    $resource = $zip->open($filePath);

    if(! file_exists($unzipPath)) {
        mkdir($unzipPath, 0755, true);
    }

    if ($resource !== true) {
        echo 'Unzip failed. Error code: '.$resource;
        return false;
    }

    $zip->extractTo($unzipPath);
    $zip->close();

    return true;
}

if (getenv('BREF_DOWNLOAD_VENDOR')) {
    if(! file_exists('/tmp/vendor') || ! file_exists('/tmp/vendor/autoload.php')) {
        downloadVendorArchive(getenv('BREF_DOWNLOAD_VENDOR'), '/tmp/vendor.zip');

        $unzipped = unzipVendorArchive('/tmp/vendor.zip', '/tmp/vendor/');

        if(! $unzipped) {
            throw new \Exception('Unable to unzip vendor archive.');
        }

        unlink('/tmp/vendor.zip');

        $updatedStaticLoader = str_replace("__DIR__ . '/../..'", "'/var/task'", file_get_contents('/tmp/vendor/composer/autoload_static.php'));
        file_put_contents('/tmp/vendor/composer/autoload_static.php', $updatedStaticLoader);
    }

    require '/tmp/vendor/autoload.php';
} elseif (getenv('BREF_AUTOLOAD_PATH')) {
    /** @noinspection PhpIncludeInspection */
    require getenv('BREF_AUTOLOAD_PATH');
} else {
    /** @noinspection PhpIncludeInspection */
    require $appRoot . '/vendor/autoload.php';
}

$lambdaRuntime = LambdaRuntime::fromEnvironmentVariable();

$container = Bref::getContainer();

try {
    $handler = $container->get(getenv('_HANDLER'));
} catch (Throwable $e) {
    $lambdaRuntime->failInitialization($e->getMessage());
}

$loopMax = getenv('BREF_LOOP_MAX') ?: 1;
$loops = 0;
while (true) {
    if (++$loops > $loopMax) {
        exit(0);
    }
    $lambdaRuntime->processNextEvent($handler);
}
