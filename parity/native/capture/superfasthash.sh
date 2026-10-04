#!/usr/bin/env bash
# Golden values for crates/timo-platform/src/capture/display_id.rs: compile
# Chromium 130.0.6723.118's SuperFastHash (what base::PersistentHash calls) and
# print the hash of each test string. Needs `cc` and network access.
set -euo pipefail
work=$(mktemp -d /tmp/timo-sfh.XXXXXX)
trap 'rm -rf "$work"' EXIT
curl -sL "https://chromium.googlesource.com/chromium/src/+/130.0.6723.118/base/third_party/superfasthash/superfasthash.c?format=TEXT" | base64 -d > "$work/superfasthash.c"
cat > "$work/main.c" <<'C'
#include <stdio.h>
#include <stdint.h>
#include <string.h>
uint32_t SuperFastHash(const char*, int);
static void show(const char* label, const char* s, int n) { printf("%-45s %u\n", label, SuperFastHash(s, n)); }
int main(void) {
  const char* text[] = {"", "a", "ab", "abc", "abcd", "abcde", "\\\\.\\DISPLAY1", "\\\\.\\DISPLAY2",
    "0/0/0", "46285/0/4353", "1234567890/-1/4294967295", "46285/0/4354", "4294967295/2147483647/65793",
    "The quick brown fox jumps over the lazy dog"};
  for (size_t i = 0; i < sizeof(text) / sizeof(text[0]); i++) show(text[i], text[i], (int)strlen(text[i]));
  show("bytes E9", "\xE9", 1);
  show("bytes C3 A9", "\xC3\xA9", 2);
  show("bytes FF FE FD", "\xFF\xFE\xFD", 3);
}
C
cc -O1 -o "$work/sfh" "$work/main.c" "$work/superfasthash.c"
"$work/sfh"
