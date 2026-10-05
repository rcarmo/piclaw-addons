#define _GNU_SOURCE
/* Synthetic regression binary executed only inside the sandbox. */
#include <sys/syscall.h>
#include <sys/socket.h>
#include <unistd.h>
#include <sched.h>
#include <stdio.h>
#include <errno.h>
int main(void) {
  int failed = 0;
  long a = syscall(SYS_unshare, CLONE_NEWUSER);
  printf("unshare=%ld errno=%d\n", a, errno); if (a != -1 || errno != EPERM) failed++;
  long b = syscall(SYS_mount, "none", "/tmp", "tmpfs", 0, 0);
  printf("mount=%ld errno=%d\n", b, errno); if (b != -1 || errno != EPERM) failed++;
  long c = syscall(SYS_socket, AF_INET, SOCK_STREAM, 0);
  printf("network=%ld errno=%d\n", c, errno); if (c != -1 || errno != EPERM) failed++;
  long d = syscall(SYS_keyctl, 0, 0, 0, 0, 0);
  printf("keyctl=%ld errno=%d\n", d, errno); if (d != -1 || errno != EPERM) failed++;
  return failed ? 1 : 0;
}
