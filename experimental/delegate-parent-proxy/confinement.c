#define _GNU_SOURCE
/* Unprivileged Linux/x86_64 namespace launcher. No setuid, runtime install or
 * arbitrary host bind mounts. Root is a parent-created disposable snapshot. */
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void die(const char *s) { perror(s); _exit(125); }
static void textfile(const char *p, const char *s) {
  int fd = open(p, O_WRONLY | O_CLOEXEC); if (fd < 0) die("map open");
  size_t n = strlen(s); if (write(fd, s, n) != (ssize_t)n) die("map write"); close(fd);
}
static void join(char *dst, size_t n, const char *root, const char *suffix) {
  if (snprintf(dst, n, "%s%s", root, suffix) >= (int)n) die("path length");
}
static void bind_mount(const char *src, const char *dst, int writable) {
  if (mount(src, dst, NULL, MS_BIND, NULL)) die("bind");
  if (mount(NULL, dst, NULL, MS_BIND | MS_REMOUNT | MS_NOSUID | (writable ? 0 : MS_RDONLY), NULL)) die("bind flags");
}
#define DENY(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void restrict_syscalls(void) {
#if !defined(__x86_64__)
#error "Only Linux x86_64 qualified"
#endif
  struct sock_filter f[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    DENY(unshare), DENY(setns), DENY(mount), DENY(umount2), DENY(pivot_root), DENY(chroot),
    DENY(ptrace), DENY(process_vm_readv), DENY(process_vm_writev), DENY(pidfd_getfd),
    DENY(open_by_handle_at), DENY(name_to_handle_at), DENY(keyctl), DENY(add_key), DENY(request_key),
    DENY(bpf), DENY(perf_event_open), DENY(userfaultfd), DENY(io_uring_setup),
    DENY(fsopen), DENY(fsconfig), DENY(fsmount), DENY(open_tree), DENY(move_mount), DENY(mount_setattr),
    DENY(kexec_load), DENY(init_module), DENY(finit_module), DENY(delete_module), DENY(reboot),
    DENY(swapon), DENY(swapoff),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = { .len = sizeof(f) / sizeof(f[0]), .filter = f };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog)) die("seccomp");
}
int main(int argc, char **argv) {
  if (argc < 5 || (strcmp(argv[2], "read_only") && strcmp(argv[2], "workspace_write")) || argv[3][0] != '/') return 125;
  uid_t uid = getuid(); gid_t gid = getgid();
  if (!uid || geteuid() != uid || getegid() != gid) return 125;
  pid_t original_parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != original_parent) return 125;
  char root[4096]; if (!realpath(argv[1], root)) die("root");
  struct stat st; if (stat(root, &st) || !S_ISDIR(st.st_mode) || st.st_uid != uid || (st.st_mode & 077)) return 125;
  if (unshare(CLONE_NEWUSER)) die("user namespace");
  char map[80]; textfile("/proc/self/setgroups", "deny");
  snprintf(map, sizeof(map), "0 %u 1\n", uid); textfile("/proc/self/uid_map", map);
  snprintf(map, sizeof(map), "0 %u 1\n", gid); textfile("/proc/self/gid_map", map);
  if (unshare(CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWPID)) die("namespaces");
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) die("private mounts");
  bind_mount(root, root, 1);
  char path[4096];
  for (const char **dev = (const char *[]){"/dev/null", "/dev/zero", "/dev/urandom", "/dev/random", NULL}; *dev; dev++) {
    join(path, sizeof(path), root, *dev); bind_mount(*dev, path, 1);
  }
  join(path, sizeof(path), root, "/tmp");
  if (mount("tmpfs", path, "tmpfs", MS_NOSUID | MS_NODEV, "size=128m,mode=1777")) die("tmp");
  join(path, sizeof(path), root, "/home");
  if (mount("tmpfs", path, "tmpfs", MS_NOSUID | MS_NODEV, "size=32m,mode=700")) die("home");
  join(path, sizeof(path), root, "/work"); bind_mount(path, path, !strcmp(argv[2], "workspace_write"));
  if (mount(NULL, root, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL)) die("readonly root");
  int life[2]; if (pipe2(life, O_CLOEXEC)) die("lifetime pipe");
  pid_t pid = fork(); if (pid < 0) die("fork");
  if (!pid) {
    close(life[1]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL)) die("child death signal");
    struct pollfd p = { .fd = life[0], .events = POLLIN };
    if (poll(&p, 1, 0) < 0 || (p.revents & POLLHUP)) _exit(125);
    close(life[0]);
    if (chdir(root) || chroot(".") || chdir("/work")) die("root switch");
    if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_RDONLY, NULL)) die("private proc");
    if (sethostname("delegate", 8)) die("hostname");
    struct rlimit core = {0, 0}, files = {128, 128};
    if (setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_NOFILE, &files)) die("rlimit");
    for (int cap = 0; cap <= CAP_LAST_CAP; cap++) if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)) die("cap bounding");
    struct __user_cap_header_struct h = { _LINUX_CAPABILITY_VERSION_3, 0 };
    struct __user_cap_data_struct d[2] = {{0}, {0}};
    if (syscall(SYS_capset, &h, &d)) die("capset");
    restrict_syscalls();
    if (syscall(SYS_close_range, 5U, ~0U, 0)) die("close inherited fds");
    execv(argv[3], &argv[3]); die("exec");
  }
  close(life[0]); close(3); close(4); // only the child owns the private provider pipe
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != original_parent) { kill(pid, SIGKILL); return 125; }
  int status;
  while (waitpid(pid, &status, 0) < 0) if (errno != EINTR) die("wait");
  close(life[1]);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
