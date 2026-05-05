/*
 * gifmaker.h
 *
 * Copyright (c) 2026 info@solarized.dev
 *
 * SPDX-License-Identifier: MIT
 */

#ifndef H_GIFMAKER
#define H_GIFMAKER

#include <jni.h>

#include "helpers.h"

static char *gifmaker_runnable_class_path_name = "com/solarized/firedown/ffmpegutils/FFmpegGifMaker";
static JavaField gifmaker_m_native = {"mNativeGifMaker", "J"};
static JavaMethod gifMakerProgress = {"gifMakerProgress", "(JJ)V"};
static JavaMethod gifMakerStarted = {"gifMakerStarted", "()V"};
static JavaMethod gifMakerFinished = {"gifMakerFinished", "()V"};

int jni_gifmaker_init(JNIEnv *env, jobject thiz);
void jni_gifmaker_dealloc(JNIEnv *env, jobject thiz);
int jni_gifmaker_start(JNIEnv *env, jobject thiz, jstring filePath, jstring outputPath,
                       jlong startMs, jlong endMs, jint fps, jint width);
void jni_gifmaker_stop(JNIEnv *env, jobject thiz);
void jni_gifmaker_interrupt(JNIEnv *env, jobject thiz);

static JNINativeMethod gifmaker_methods[] = {
        {"initGifMaker",      "()I",                                 (void *) jni_gifmaker_init},
        {"startGifMaker",     "(Ljava/lang/String;Ljava/lang/String;JJII)I",
                                                                     (void *) jni_gifmaker_start},
        {"stopGifMaker",      "()V",                                 (void *) jni_gifmaker_stop},
        {"interruptGifMaker", "()V",                                 (void *) jni_gifmaker_interrupt},
        {"deallocGifMaker",   "()V",                                 (void *) jni_gifmaker_dealloc},
};

#endif
