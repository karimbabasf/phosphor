// The shell's code-signature questions that are not the XPC peer's (libxpc asks that one, in
// xpc_bridge.c): which team signed this process, and whether a process it started is signed by
// that team. C for the reason the bridge is: Security.framework is a C API, and the `cc` crate
// that compiles the bridge compiles this beside it.

#include <Security/Security.h>
#include <stdio.h>
#include <unistd.h>

// The Team ID this process is signed with, or 0 when it has none (ad-hoc) or it cannot be read.
int phosphor_own_team(char *out, size_t len) {
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

// 1 when process `pid`, as the kernel runs it, is signed by a Developer ID Application
// certificate (the leaf carries Apple's 1.2.840.113635.100.6.1.13) of Team ID `team`; 0 when it
// is not, with the Security framework's status in *status. The running process is what is asked
// about, never the file it came from, so a file swapped after the check cannot pass for it, and
// a file swapped before it no longer matches the process.
int phosphor_pid_signed_by(pid_t pid, const char *team, int *status) {
    char text[256];
    int n = snprintf(text, sizeof text,
                     "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] and "
                     "certificate leaf[subject.OU] = \"%s\"",
                     team);
    if (n < 0 || (size_t)n >= sizeof text) {
        *status = errSecParam;
        return 0;
    }
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
    const void *keys[] = {kSecGuestAttributePid};
    const void *values[] = {number};
    CFDictionaryRef attributes =
        CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFStringRef source = CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8);
    SecCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    OSStatus result = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code);
    if (result == errSecSuccess) result = SecRequirementCreateWithString(source, kSecCSDefaultFlags, &requirement);
    if (result == errSecSuccess) result = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement);
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    CFRelease(source);
    CFRelease(attributes);
    CFRelease(number);
    *status = (int)result;
    return result == errSecSuccess;
}
