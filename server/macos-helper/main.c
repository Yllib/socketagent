#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int read_start_script(char *buffer, size_t size) {
  const char *configured = getenv("SOCKETAGENT_START_SCRIPT");
  if (configured != NULL && configured[0] != '\0') {
    snprintf(buffer, size, "%s", configured);
    return 0;
  }

  const char *home = getenv("HOME");
  if (home == NULL || home[0] == '\0') return -1;
  snprintf(buffer, size, "%s/socketagent/server/scripts/start-server.sh", home);
  return 0;
}

int main(void) {
  char start_script[PATH_MAX];
  if (read_start_script(start_script, sizeof(start_script)) != 0) {
    fputs("SocketAgent Server could not determine the startup script path.\n", stderr);
    return 1;
  }

  setenv("SOCKETAGENT_MACOS_HELPER", "1", 1);
  execl("/bin/bash", "bash", start_script, (char *)NULL);
  fprintf(stderr, "SocketAgent Server could not launch %s: %s\n", start_script, strerror(errno));
  return 1;
}
