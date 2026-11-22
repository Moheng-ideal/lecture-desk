function Get-VoiceAsset($Name, $Url, $Hash) {
    $path = Join-Path '.sites-runtime/voice-sdk' $Name
    if (!(Test-Path -LiteralPath $path)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
        curl.exe --fail --location --silent --show-error --retry 2 --max-time 300 $Url --output "$path.download"
        if ((Get-FileHash -LiteralPath "$path.download").Hash -ne $Hash) { throw "Checksum mismatch for $Name" }
        Move-Item -LiteralPath "$path.download" -Destination $path
    }
    if ((Get-FileHash -LiteralPath $path).Hash -ne $Hash) { throw "Checksum mismatch for $Name" }
    return (Resolve-Path -LiteralPath $path).Path
}

function Get-AndroidVoice($Stage) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $vendor = Join-Path $Stage 'voice'
    New-Item -ItemType Directory -Force -Path "$vendor/vosk", "$vendor/jna" | Out-Null
    $vosk = Get-VoiceAsset 'vosk-android-0.3.75.aar' 'https://repo.maven.apache.org/maven2/com/alphacephei/vosk-android/0.3.75/vosk-android-0.3.75.aar' 'AB2F8B91AC8051561AA325546B35FED9A68B36B8121BAC5C6FB927525C4ADFAD'
    $jna = Get-VoiceAsset 'jna-5.18.1.aar' 'https://repo.maven.apache.org/maven2/net/java/dev/jna/jna/5.18.1/jna-5.18.1.aar' '7F053E3EC99E14DD71259C82C1C8A02738D64A13C31226B2ACC170F3060951E0'
    $model = Get-VoiceAsset 'vosk-model-small-cn-0.22.zip' 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip' '3AF8B0E7E0F835AE9D414CE5DF580237A3CFB08D586C9FBBB0F7FF29AD5B14BA'
    $license = Get-VoiceAsset 'Apache-2.0.txt' 'https://www.apache.org/licenses/LICENSE-2.0.txt' 'CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30'
    $voskDir = (Resolve-Path -LiteralPath "$vendor/vosk").Path
    $jnaDir = (Resolve-Path -LiteralPath "$vendor/jna").Path
    [IO.Compression.ZipFile]::ExtractToDirectory($vosk, $voskDir)
    [IO.Compression.ZipFile]::ExtractToDirectory($jna, $jnaDir)
    return @{ Vosk = $voskDir; Jna = $jnaDir; Model = $model; License = $license }
}

function Add-AndroidVoice($Archive, $Voice) {
    foreach ($abi in @('arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86')) {
        foreach ($item in @(@($Voice.Vosk, 'libvosk.so'), @($Voice.Jna, 'libjnidispatch.so'))) {
            $folder, $name = $item
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive, "$folder/jni/$abi/$name", "lib/$abi/$name") | Out-Null
        }
    }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive, $Voice.Model, 'assets/voice/vosk-model-small-cn-0.22.zip', [IO.Compression.CompressionLevel]::NoCompression) | Out-Null
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive, $Voice.License, 'assets/voice/Apache-2.0.txt') | Out-Null
    foreach ($vendor in @($Voice.Vosk, $Voice.Jna)) {
        $jar = [IO.Compression.ZipFile]::OpenRead("$vendor/classes.jar")
        try {
            foreach ($entry in $jar.Entries | Where-Object { $_.Name -match '^(LICENSE|NOTICE|COPYING|LGPL|AL2)' }) {
                $copy = $Archive.CreateEntry("assets/voice/$(Split-Path $vendor -Leaf)-$($entry.Name)")
                $target = $copy.Open()
                $source = $entry.Open()
                try { $source.CopyTo($target) } finally { $source.Dispose(); $target.Dispose() }
            }
        } finally { $jar.Dispose() }
    }
}
