param(
    [Parameter(Mandatory)][string]$AndroidJar,
    [Parameter(Mandatory)][string]$BuildTools,
    [Parameter(Mandatory)][string]$JavaHome,
    [string]$OutputApk
)

$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $true
# Windows PowerShell 5.1 turns native stderr (javac/keytool warnings) into
# terminating errors under 'Stop'. Run native tools with stderr merged and
# check $LASTEXITCODE explicitly instead.
function Invoke-Native {
    param([scriptblock]$Command, [string]$Label)
    & $Command 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
}
$AndroidJar = (Resolve-Path -LiteralPath $AndroidJar).Path
$BuildTools = (Resolve-Path -LiteralPath $BuildTools).Path
$JavaHome = (Resolve-Path -LiteralPath $JavaHome).Path
$repo = Split-Path $PSScriptRoot
$version = (Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json).version
$parts = [version]$version
$versionCode = $parts.Major * 10000 + $parts.Minor * 100 + $parts.Build
$aapt = Join-Path $BuildTools 'aapt2.exe'
$zipalign = Join-Path $BuildTools 'zipalign.exe'
$java = Join-Path $JavaHome 'bin/java.exe'
$signer = Join-Path $BuildTools 'lib/apksigner.jar'

Push-Location $repo
try {
    # AAPT2 on Windows can read relative paths from a non-ASCII workspace.
    # Windows PowerShell 5.1 lacks [IO.Path]::GetRelativePath; both paths here
    # are plain ASCII, so the absolute path is safe to pass straight through.
    $platform = $AndroidJar
    $stage = Join-Path '.sites-runtime' ('android-build-' + [Guid]::NewGuid().ToString('N'))
    $classesDirectory = Join-Path $stage 'classes'
    $dexDirectory = Join-Path $stage 'dex'
    $signingDirectory = '.sites-runtime/android-signing'
    New-Item -ItemType Directory -Force -Path $classesDirectory, $dexDirectory, $signingDirectory, 'release' | Out-Null
    $resources = Join-Path $stage 'resources.zip'
    $unsigned = Join-Path $stage 'unsigned.apk'
    $aligned = Join-Path $stage 'aligned.apk'
    $signed = Join-Path $stage 'signed.apk'
    $output = if ($OutputApk) { $OutputApk } else { "release/lecture-desk-android-$version.apk" }
    $store = Join-Path $signingDirectory 'lecture-desk.p12'
    $passwordFile = Join-Path $signingDirectory 'store.secret'

    # Rebuild the web assets only when missing (the npm wrapper can be
    # sandboxed away in some environments; pre-generated assets are fine).
    if (!(Test-Path -LiteralPath 'android/assets/desk/index.html')) {
        Invoke-Native -Label 'build:android-assets' -Command { node scripts/harmony.mjs android }
    }
    Invoke-Native -Label 'aapt2 compile' -Command { & $aapt compile --dir android/res -o $resources }
    Invoke-Native -Label 'aapt2 link' -Command {
        & $aapt link -I $platform --manifest android/AndroidManifest.xml `
            --min-sdk-version 26 --target-sdk-version 34 --version-code $versionCode --version-name $version `
            -o $unsigned $resources
    }

    $sources = @(Get-ChildItem -LiteralPath 'android/src' -Recurse -Filter '*.java' -File | ForEach-Object FullName)
    Invoke-Native -Label 'javac' -Command {
        & (Join-Path $JavaHome 'bin/javac.exe') --release 11 -encoding UTF-8 -classpath $AndroidJar -d $classesDirectory @sources
    }
    $classes = @(Get-ChildItem -LiteralPath $classesDirectory -Recurse -Filter '*.class' -File | ForEach-Object FullName)
    Invoke-Native -Label 'd8' -Command {
        & $java -cp (Join-Path $BuildTools 'lib/d8.jar') com.android.tools.r8.D8 `
            --min-api 26 --lib $AndroidJar --output $dexDirectory @classes
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    $archive = [IO.Compression.ZipFile]::Open((Resolve-Path -LiteralPath $unsigned).Path, [IO.Compression.ZipArchiveMode]::Update)
    try {
        Get-ChildItem -LiteralPath $dexDirectory -Filter 'classes*.dex' -File | ForEach-Object {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $_.Name) | Out-Null
        }
        # AssetManager expects forward slashes even when the APK is built on Windows.
        $assets = (Resolve-Path -LiteralPath 'android/assets').Path
        $prefix = $assets.TrimEnd('\') + '\'
        Get-ChildItem -LiteralPath $assets -Recurse -File | ForEach-Object {
            $name = $_.FullName.Substring($prefix.Length).Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, "assets/$name") | Out-Null
        }
    } finally {
        $archive.Dispose()
    }
    Invoke-Native -Label 'zipalign' -Command { & $zipalign -f -p 4 $unsigned $aligned }

    $existingStore = Test-Path -LiteralPath $store -PathType Leaf
    $existingPassword = Test-Path -LiteralPath $passwordFile -PathType Leaf
    if ($existingStore -ne $existingPassword) {
        throw 'Restore the missing APK signing file before building an update.'
    }
    if (!$existingStore) {
        $env:LECTURE_DESK_APK_PASS = [Guid]::NewGuid().ToString('N')
        Invoke-Native -Label 'keytool' -Command {
            & (Join-Path $JavaHome 'bin/keytool.exe') -genkeypair -storetype PKCS12 -keystore $store -alias lecture-desk `
                -storepass:env LECTURE_DESK_APK_PASS -keypass:env LECTURE_DESK_APK_PASS `
                -keyalg RSA -keysize 2048 -validity 9000 -dname 'CN=Lecture Desk Android'
        }
        Set-Content -LiteralPath $passwordFile -Value $env:LECTURE_DESK_APK_PASS -NoNewline -Encoding ascii
    } else {
        $env:LECTURE_DESK_APK_PASS = Get-Content -LiteralPath $passwordFile -Raw
    }

    Invoke-Native -Label 'apksigner sign' -Command {
        & $java -jar $signer sign --ks $store --ks-key-alias lecture-desk --ks-pass env:LECTURE_DESK_APK_PASS `
            --out $signed $aligned
    }
    Invoke-Native -Label 'apksigner verify' -Command { & $java -jar $signer verify --verbose $signed }
    Invoke-Native -Label 'zipalign check' -Command { & $zipalign -c -p 4 $signed }
    Copy-Item -LiteralPath $signed -Destination $output -Force
    Get-Item -LiteralPath $output
} finally {
    $env:LECTURE_DESK_APK_PASS = $null
    Pop-Location
}
