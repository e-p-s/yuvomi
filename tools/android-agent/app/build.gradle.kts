plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "de.eps.yuvomi.tracker"
    compileSdk = 34

    defaultConfig {
        applicationId = "de.eps.yuvomi.tracker"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")

    // Lokaler Offline-Puffer (pending_sessions) + Ausnahmen-Cache
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")

    // Upload-Kette: 15-min-Boden zusaetzlich zum 60s-Heartbeat im Service
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // Pairing-Token + Base-URL verschluesselt (EncryptedSharedPreferences)
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // HTTP
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // QR-Scanner (zxing-android-embedded) ist bewusst NICHT verlinkt: Pairing laeuft
    // ueber Deep-Link (yuvomi://pair) oder Abtippen. Kamera-Code ohne getesteten Build
    // waere toter Code; Fuer Fall A: hier die Dep + ScanActivity ergaenzen.
}
