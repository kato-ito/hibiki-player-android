import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 发布签名（keystore.properties 存在时启用；不存在则构建未签名包）
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
    namespace = "com.zai.hibikiplayer"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.zai.hibikiplayer"
        minSdk = 24
        targetSdk = 35
        versionCode = 19
        versionName = "2.31.1"
        // 只打包手机用得到的架构（x86/x86_64 仅模拟器需要，排除以缩小安装包）
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    signingConfigs {
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
                // minSdk 24 起 v1(JAR) 签名非必需；同时启用 v2+v3，兼容 Android 7 ~ 15
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (keystorePropsFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    sourceSets {
        getByName("main") {
            // 打包根目录 www 下的页面（APK 内为 assets/index.html）
            assets.srcDirs(rootProject.file("../www").absolutePath)
        }
    }
    // 按 CPU 架构分包：手机只需装对应架构的小包；另出一个通用包
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a")
            isUniversalApk = true
        }
    }
}

dependencies {
    // Android SDK + Kotlin 标准库 + 内置 ffmpeg（杜比 / DTS 解码与多声道 PCM 输出）
    implementation("com.arthenica:ffmpeg-kit-min:6.0-2")

    // JVM 单元测试：命名规则（BiliNaming）等纯逻辑，跑 gradle :app:testDebugUnitTest
    testImplementation("junit:junit:4.13.2")
}

