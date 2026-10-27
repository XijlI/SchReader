import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The release workflow passes the tag's version in:
//   ./gradlew assembleRelease -PappVersionName=1.2.3 -PappVersionCode=10203
// A plain local build keeps the defaults below, so nothing breaks offline.
val appVersionName = (project.findProperty("appVersionName") as String?) ?: "0.1.0"
val appVersionCode = (project.findProperty("appVersionCode") as String?)?.toIntOrNull() ?: 1

// Release signing key: either android/keystore.properties (local, gitignored) or the
// NV_* env vars the release workflow exports. Without either, `assembleRelease`
// falls back to the debug key so it still produces an installable APK.
val signingProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun signingValue(key: String, env: String): String? =
    (signingProps.getProperty(key) ?: System.getenv(env))?.takeIf { it.isNotBlank() }

val releaseStorePath = signingValue("storeFile", "NV_KEYSTORE_FILE")

android {
    namespace = "com.schreader.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.schreader.app"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        if (releaseStorePath != null) {
            create("release") {
                storeFile = if (File(releaseStorePath).isAbsolute) {
                    File(releaseStorePath)
                } else {
                    rootProject.file(releaseStorePath)
                }
                storePassword = signingValue("storePassword", "NV_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "NV_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "NV_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Without a real keystore this keeps `assembleRelease` installable
            // (debug signature); CI warns loudly when that happens.
            signingConfig = signingConfigs.findByName("release")
                ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

// extension/ is the single source of truth for the reader and library pages: regenerate the
// mirrored assets before every build, so a local `assembleRelease` cannot ship stale pages
// (the release workflow used to be the only thing that ran mirror.py).
val mirrorWeb = tasks.register<Exec>("mirrorWeb") {
    workingDir = rootProject.projectDir
    commandLine("python3", "tools/mirror.py")
    inputs.dir(rootProject.file("../extension"))
    outputs.dir(file("src/main/assets"))
}
tasks.named("preBuild") { dependsOn(mirrorWeb) }

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
}
