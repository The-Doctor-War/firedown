/*
 * helpers.c
 *
 * Copyright (c) 2026 info@solarized.dev
 *
 * SPDX-License-Identifier: MIT
 */

#include <jni.h>

#include "helpers.h"


JavaMethod empty_constructor = {"<init>", "()V"};

// HashMap
char *hash_map_class_path_name = "java/util/HashMap";
char *map_class_path_name = "java/util/Map";
JavaMethod map_key_set = {"keySet", "()Ljava/util/Set;"};
JavaMethod map_get = {"get", "(Ljava/lang/Object;)Ljava/lang/Object;"};
JavaMethod map_put = {"put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;"};


// Set
char *set_class_path_name = "java/util/Set";
JavaMethod set_iterator = {"iterator", "()Ljava/util/Iterator;"};

// Iterator
char *iterator_class_path_name = "java/util/Iterator";
JavaMethod iterator_next = {"next", "()Ljava/lang/Object;"};
JavaMethod iterator_has_next = {"hasNext", "()Z"};



jfieldID java_get_field(JNIEnv *env, char * class_name, JavaField field) {
	jclass clazz = (*env)->FindClass(env, class_name);
	if (clazz == NULL) {
		/* FindClass leaves a pending ClassNotFoundException / NoClassDefFoundError;
		 * GetFieldID(NULL, ...) is undefined behaviour and on Android JNI it
		 * triggers an assertion abort. Clear the exception and bail with NULL —
		 * callers all check the return value. Path normally only fires under
		 * a misconfigured ProGuard / R8 rename. */
		if ((*env)->ExceptionCheck(env)) {
			(*env)->ExceptionClear(env);
		}
		return NULL;
	}
	jfieldID jField = (*env)->GetFieldID(env, clazz, field.name, field.signature);
	(*env)->DeleteLocalRef(env, clazz);
	return jField;
}

jmethodID java_get_method(JNIEnv *env, jclass class, JavaMethod method) {
	return (*env)->GetMethodID(env, class, method.name, method.signature);
}

jmethodID java_get_static_method(JNIEnv *env, jclass class, JavaMethod method) {
	return (*env)->GetStaticMethodID(env, class, method.name, method.signature);
}
