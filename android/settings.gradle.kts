pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // ffmpeg-kit 已从 Maven Central 下架（项目退役），国内镜像仍保留：
        // 先查镜像，再回落到官方仓库
        maven {
            url = uri("https://maven.aliyun.com/repository/public")
            content { includeGroup("com.arthenica") }
        }
        maven {
            url = uri("https://repo.huaweicloud.com/repository/maven/")
            content { includeGroup("com.arthenica") }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "Hibiki Player"
include(":app")
