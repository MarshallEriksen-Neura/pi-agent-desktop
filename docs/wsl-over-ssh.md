# Use WSL through an SSH execution profile

Pi Desktop treats WSL like any other Unix execution host. There is no WSL runtime mode, distro detection, path translation, or automatic WSL configuration in the app.

The execution path is:

```text
Pi Desktop on Windows -> SSH -> sshd in WSL -> remote launcher -> Pi in WSL
```

## Prerequisites

Configure these outside Pi Desktop:

1. Install and run an SSH server (`sshd`) in the WSL distribution.
2. Make that server reachable from Windows. Choose and maintain the port, forwarding, firewall, and WSL networking settings appropriate for your machine.
3. Configure key-based access or another authentication method supported by your system `ssh` client.
4. Install Node.js and Pi in the WSL distribution.
5. Add a host entry to the Windows user's `~/.ssh/config`.

For example, if the WSL SSH server is already reachable on local port `2222`:

```sshconfig
Host my-wsl
  HostName 127.0.0.1
  Port 2222
  User your-linux-user
  IdentityFile ~/.ssh/id_ed25519
```

Pi Desktop does **not** install or start `sshd`, generate keys, reserve a port, change firewall rules, or create this SSH entry.

## Verify SSH first

From a Windows terminal, verify that the same host alias works without interactive setup:

```powershell
ssh my-wsl 'printf "connected: "; pwd; command -v node; command -v pi'
```

Resolve host-key, authentication, PATH, and connectivity errors in the terminal before adding the profile to Pi Desktop.

## Add the profile

In **Settings -> Runtime -> Remote agent profiles**:

1. Add a profile.
2. Set **SSH host** to the alias from `~/.ssh/config` (for example, `my-wsl`).
3. Set the remote workspace to an absolute Linux path such as `/home/your-linux-user/project`.
4. Run the profile readiness check and install or update the remote launcher when prompted.
5. Select the SSH profile as the conversation's execution target.

Paths in this profile are Linux paths owned by the SSH target. Pi Desktop does not convert Windows paths such as `D:\project` into `/mnt/d/project`.

## Session ownership

A conversation created with this profile remains bound to that SSH profile and remote working directory. A conversation created by an older desktop WSL shell mode remains a Windows `local` conversation; Pi Desktop does not relabel it as SSH automatically.
