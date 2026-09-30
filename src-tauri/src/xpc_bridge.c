// The shell's half of the XPC hop to the Secure Enclave service (src-tauri/se-helper/main.swift).
//
// WHY C. libxpc is a C API whose callbacks are blocks, and clang compiles blocks natively on
// macOS. Rust would need a blocks crate and hand-written bindings for the same four calls; this
// file is the whole bridge, compiled by the `cc` crate that is already in Cargo.lock.
//
// One call is one connection: open it, send the request, wait for the reply, cancel it. Nothing
// is kept between calls, which is the same promise the stdin sidecar made.

#include <dispatch/dispatch.h>
#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <xpc/xpc.h>

// The Team ID this process is signed with, or 0 when it has none (ad-hoc) or it cannot be read.
static int own_team(char *out, size_t len) {
    SecCodeRef me = NULL;
    SecStaticCodeRef mine = NULL;
    CFDictionaryRef info = NULL;
    int found = 0;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &me) == errSecSuccess &&
        SecCodeCopyStaticCode(me, kSecCSDefaultFlags, &mine) == errSecSuccess &&
        SecCodeCopySigningInformation(mine, kSecCSSigningInformation, &info) == errSecSuccess) {
        CFStringRef team = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
        found = team != NULL && CFStringGetCString(team, out, (CFIndex)len, kCFStringEncodingUTF8) && out[0] != '\0';
    }
    if (info) CFRelease(info);
    if (mine) CFRelease(mine);
    if (me) CFRelease(me);
    return found;
}

// Sends one JSON request to the named service and returns its JSON answer, malloc'd, for the
// caller to free. On failure returns NULL and points *error at a static failure code.
//
// The service is held to a requirement too: its identifier, and under a Developer ID signature
// the same Team ID as this process. It lives inside the sealed bundle already; this is the check
// that a service answering under that name is the one that was sealed.
char *phosphor_xpc_call(const char *service, const char *request, double timeout_secs, const char **error) {
    char team[64] = {0};
    char requirement[512];
    if (own_team(team, sizeof team)) {
        snprintf(requirement, sizeof requirement,
                 "anchor apple generic and identifier \"%s\" and certificate leaf[subject.OU] = \"%s\"", service, team);
    } else {
        snprintf(requirement, sizeof requirement, "identifier \"%s\"", service);
    }

    xpc_connection_t conn = xpc_connection_create(service, NULL);
    if (xpc_connection_set_peer_code_signing_requirement(conn, requirement) != 0) {
        xpc_connection_cancel(conn);
        xpc_release(conn);
        *error = "helper_unverified";
        return NULL;
    }
    xpc_connection_set_event_handler(conn, ^(xpc_object_t event) { (void)event; });
    xpc_connection_resume(conn);

    xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_string(message, "request", request);
    dispatch_queue_t queue = dispatch_queue_create("com.karimbabasf.phosphor.vault.reply", DISPATCH_QUEUE_SERIAL);
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block char *answer = NULL;
    __block const char *failed = NULL;
    xpc_connection_send_message_with_reply(conn, message, queue, ^(xpc_object_t reply) {
        if (xpc_get_type(reply) == XPC_TYPE_DICTIONARY) {
            const char *text = xpc_dictionary_get_string(reply, "answer");
            if (text) answer = strdup(text);
            else failed = "helper_garbled";
        } else if (reply == XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT) {
            failed = "helper_unverified";
        } else {
            // No such service in this bundle, a service that refused this process, or one that
            // died mid-request. The shell cannot tell these apart and does not need to.
            failed = "helper_unreachable";
        }
        dispatch_semaphore_signal(done);
    });
    xpc_release(message);

    int64_t wait_ns = (int64_t)(timeout_secs * (double)NSEC_PER_SEC);
    long timed_out = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, wait_ns));
    xpc_connection_cancel(conn);
    if (timed_out) {
        // libxpc runs every reply handler exactly once; after the cancel it runs with
        // XPC_ERROR_CONNECTION_INVALID, so this wait ends and nothing writes after the return.
        dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
        free(answer);
        answer = NULL;
        failed = "helper_timeout";
    }
    xpc_release(conn);
    dispatch_release(done);
    dispatch_release(queue);
    if (!answer) *error = failed ? failed : "helper_unreachable";
    return answer;
}
