plugins {
    id("com.android.application") version "9.1.1"
}

android {
    namespace = "dev.jupiter.selfadb.probe"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.jupiter.selfadb.probe"
        minSdk = 34
        targetSdk = 36
        versionCode = 1
        versionName = "1"
    }
}

dependencies {
    implementation("com.github.MuntashirAkon:libadb-android:3.1.1")
    implementation("org.conscrypt:conscrypt-android:2.5.3")
    implementation("org.bouncycastle:bcpkix-jdk15to18:1.81")
}
