import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import javax.inject.Inject

plugins { id("com.android.application") }

abstract class PrepareBundledAssets : DefaultTask() {
    @get:InputDirectory abstract val sourceDirectory: DirectoryProperty
    @get:OutputDirectory abstract val outputDirectory: DirectoryProperty
    @get:Inject abstract val files: FileSystemOperations
    @TaskAction fun prepare() {
        files.sync {
            from(sourceDirectory); into(outputDirectory)
            // AAPT treats .gz as precompressed ZIP content and strips its suffix.
            rename { name -> if (name.endsWith(".tar.gz")) name.removeSuffix(".tar.gz") + ".bundle" else name }
        }
    }
}

val runtimeDir = rootProject.file(System.getenv("JUPITER_ANDROID_OUTPUT")?.let { "$it/runtime" }
    ?: "../../output/android-local-20261101/runtime")
val qaSigningDir = file("${System.getProperty("user.home")}/.local/share/jupiter-android")
val bundledAssets = tasks.register<PrepareBundledAssets>("prepareBundledAssets") {
    sourceDirectory.set(runtimeDir.resolve("assets"))
    outputDirectory.set(layout.buildDirectory.dir("generated/bundledAssets"))
}
androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(bundledAssets, PrepareBundledAssets::outputDirectory)
}

android {
    namespace = "dev.jupiter.mobile"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "dev.jupiter.mobile.qa"
        minSdk = 29
        targetSdk = 36
        versionCode = 3
        versionName = "0.1.0-alpha"
        ndk { abiFilters += "arm64-v8a" }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        create("qa") {
            storeFile = qaSigningDir.resolve("qa-signing.p12")
            storeType = "PKCS12"
            storePassword = qaSigningDir.resolve("qa-signing.password").readText().trim()
            keyAlias = "jupiter-qa"
            keyPassword = storePassword
        }
    }
    buildTypes {
        getByName("release") {
            isDebuggable = false
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("qa")
        }
    }
    testBuildType = "release"
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].jniLibs.srcDir(runtimeDir.resolve("jniLibs"))
    sourceSets["main"].java.srcDir(rootProject.file("shared"))
    sourceSets["main"].res.srcDir(runtimeDir.resolve("android-res"))
    packaging { jniLibs { useLegacyPackaging = true } }
    androidResources { noCompress += "bundle" }
}

dependencies {
    implementation("androidx.activity:activity:1.12.4")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("androidx.core:core:1.15.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
