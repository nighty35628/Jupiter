pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io") {
            content {
                includeGroup("com.github.MuntashirAkon")
                includeGroup("com.github.MuntashirAkon.spake2-java")
            }
        }
    }
}
rootProject.name = "JupiterSelfAdbProbe"
