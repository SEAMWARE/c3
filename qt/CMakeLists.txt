#
# c3-window - c³'s own window: a Qt WebEngine view on the pages of a c3 (c3window.cpp)
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
cmake_minimum_required(VERSION 3.16)
project(c3-window LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Widgets WebEngineWidgets WebChannel)

add_executable(c3-window c3window.cpp)
target_link_libraries(c3-window PRIVATE Qt6::Widgets Qt6::WebEngineWidgets Qt6::WebChannel)
