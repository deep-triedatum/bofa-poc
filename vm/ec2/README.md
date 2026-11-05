# Setting up the two EC2 VMs with EFS

This installs the builder (editor), the proxy and the reconciler on two EC2 instances that share one EFS file system. It does not set up an npm registry: the apps' `npm install` uses the public registry until you set `NPM_REGISTRY` (see the end).

```
  users ──► (ALB or either VM) :8080
                │
      ┌─────────┴─────────┐
   vm1                  vm2           each: builder (:3000, local only) + proxy (:8080) + reconciler
      │  published apps on :20000-20999 of their own VM
      └─────────┬─────────┘
          EFS  /mnt/shared      apps/  registry/  vms/  env/
```

Assumed: Ubuntu 22.04 (Amazon Linux also works), both instances in one VPC, and you can SSH to them with sudo.

## Files

| File | Where it runs | What it does |
|---|---|---|
| `package.sh` | Your machine | Packs `builder/` (without `node_modules` or build output) into `dist/builder-<version>.tgz` |
| `bootstrap.sh` | Each VM, once | Node, service user, EFS mount, `/etc/builder/builder.env`, systemd units |
| `install-app.sh` | Each VM, for every install or update | Unpacks the package, `npm install`, `next build`, switches `/opt/builder/current`, restarts the services |
| `builder.env.example` | Template | Becomes `/etc/builder/builder.env` |
| `systemd/*.service` | Installed by `bootstrap.sh` | `builder`, `proxy`, `reconciler` |

## 1. AWS side

**EFS.** Create a file system in the instances' VPC, with a mount target in the subnet (AZ) of each instance (steps in the earlier EFS answer: console, or `aws efs create-file-system` and `create-mount-target`). Note the file system id (`fs-…`) and the region.

**Security groups.** Put both instances in one security group (call it `builder-vms`) and create `efs-sg` for the mount targets.

| Group | Rule | Why |
|---|---|---|
| `efs-sg` | Inbound TCP 2049 from `builder-vms` | VMs mount EFS |
| `builder-vms` | Inbound TCP 8080 from your users' network (or from the ALB's group) | The proxy: editor and published apps |
| `builder-vms` | Inbound TCP 20000-20999 **from `builder-vms` itself** | One VM's proxy reaches apps on the other VM. Do not open this to users |
| `builder-vms` | Inbound TCP 22 from your admin network | SSH |

The editor's own port (3000) listens on `127.0.0.1` only, so it needs no rule.

**VPC.** DNS resolution and DNS hostnames must be on, or the EFS name will not resolve.

**Load balancer (optional).** To give users one address, create an ALB with a target group of both instances on port 8080 and health check path `/_proxy/health`. **Set the ALB idle timeout to 600 seconds**: publishing runs `npm install` and a build, and the default 60 s cuts it off. Without an ALB, users can open either VM's address on :8080 and it works the same.

## 2. On your machine: package the builder

```bash
cd bofa-poc/vm/ec2
./package.sh                      # prints dist/builder-<version>.tgz
```

The version comes from `git describe`. A `-dirty` suffix means the builder has uncommitted changes, so commit and tag first if you want to know exactly what runs.

```bash
scp -r dist/builder-*.tgz bootstrap.sh install-app.sh builder.env.example systemd ubuntu@<vm1-ip>:/tmp/ec2/
scp -r dist/builder-*.tgz bootstrap.sh install-app.sh builder.env.example systemd ubuntu@<vm2-ip>:/tmp/ec2/
```

(Create `/tmp/ec2` on each VM first, or copy to your home directory.)

## 3. On each VM: bootstrap, once

Use a **different `VM_NAME` on each VM** (`vm1`, `vm2`). It is the key the registry and the reconciler use.

```bash
cd /tmp/ec2
sudo EFS_ID=fs-0123456789abcdef0 AWS_REGION=ap-south-1 VM_NAME=vm1 ./bootstrap.sh     # vm2 on the other
```

It installs Node 22 if none of version 20 or newer is found, creates the `builder` user with **uid and gid 1500** (they must match on both VMs, because files on EFS are owned by number), mounts EFS at `/mnt/shared` through `/etc/fstab`, creates `apps/ registry/ vms/ env/`, writes `/etc/builder/builder.env` (with this VM's private IP from instance metadata) and installs the three services. It stops with a message if the mount fails or the service user cannot write to the volume.

If the VM cannot reach `nodesource.com`, install Node 20 or newer from your own mirror first and run the script again.

Then check the settings, especially `PUBLIC_BASE_URL`: it is the address users type, either the ALB or DNS name, or `http://<vm-ip>:8080`.

```bash
sudo nano /etc/builder/builder.env
```

## 4. On each VM: install the app

```bash
sudo ./install-app.sh /tmp/ec2/builder-<version>.tgz
```

It unpacks to `/opt/builder/releases/<name>`, runs `npm install` and `next build` as the `builder` user, points `/opt/builder/current` at it, restarts the services and checks that the proxy and editor answer. The last three releases are kept. The same command updates the app later.

## 5. Check it

```bash
# on each VM
systemctl is-active builder proxy reconciler          # active x3
curl -s localhost:8080/_proxy/health                  # ok
ls /mnt/shared/vms                                    # vm1.json and vm2.json: both VMs see each other
```

In a browser open `http://<alb-or-vm-ip>:8080`, design a page, **Publish**, and open the link. Then:

1. **Which VM runs it:** `cat /mnt/shared/registry/<appId>.json` shows `vm`, `ip` and `port`.
2. **Reload the app's URL several times.** With an ALB the requests land on both VMs and all answer.
3. **My apps** shows it running, with Stop, Start and Delete.
4. **Failover:** `sudo systemctl stop reconciler` is not enough, because the app stays up. Stop the VM instead (EC2 console, Stop instance), or run `sudo reboot` on the VM that runs the app. About 20 seconds later (the heartbeat timeout) the other VM adopts the app and the URL answers again. After a reboot, the same VM restarts its own apps when its reconciler comes back.

## Operating

| What | Command |
|---|---|
| Service logs | `journalctl -u builder -f`, `-u proxy`, `-u reconciler` (the reconciler prints one line per action) |
| One app's log | `tail -f /mnt/shared/apps/<ait>/<appId>/releases/<n>/app.log` |
| Restart the services | `sudo systemctl restart builder proxy reconciler` |
| Update the builder | `./package.sh`, copy, `sudo ./install-app.sh …` on each VM, one VM at a time |
| Roll back | `sudo ln -sfn /opt/builder/releases/<older> /opt/builder/current && sudo systemctl restart builder proxy reconciler` |

**Published apps survive a service restart.** The `builder` and `reconciler` units use `KillMode=process`, so stopping or restarting them only stops that one process, not the apps they started. A deploy of a new builder version therefore does not take the published apps down. If you want to stop an app, use **My apps**.

**After an instance reboot,** the reconciler restarts every app that was running on that VM within about two intervals (10 s by default).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `mount failed` in bootstrap | Security group missing TCP 2049, no mount target in this AZ, VPC DNS off, or wrong id or region |
| `builder cannot write to /mnt/shared` | The `builder` uid is not 1500 on this VM, or the volume's root is owned by someone else: `ls -ldn /mnt/shared` |
| Editor works, an app gives 502 | The proxy cannot reach the other VM's app port: the `builder-vms` self-rule on 20000-20999 is missing |
| Publish ends with 504 | ALB idle timeout is still 60 s |
| An app is `failed` in My apps | Its release folder is missing from EFS, or it never answered `/healthz`: read its `app.log` and the reconciler log |
| Only one VM in `ls /mnt/shared/vms` | The other VM's reconciler is not running, or `VM_NAME` is the same on both |
| Registry shows one VM, apps move unexpectedly | Clocks differ by more than a few seconds: `chronyc tracking` (NTP) |

## Adding the npm registry later

Set `NPM_REGISTRY=http://<registry>:4873/` in `/etc/builder/builder.env` on both VMs and `sudo systemctl restart builder reconciler`. Published apps then install through it. `install-app.sh` also uses it for the builder's own install on later runs.

## Not tested

These scripts and unit files were written without access to your instances. What was checked: the shell scripts parse, `package.sh` produces a 2 MB package without `node_modules`, the unit files verify, and the editor binds to `127.0.0.1` with `next start -H 127.0.0.1`. The EFS mount, the systemd services, the security-group rules and the failover on real instances have not been run. The first run on a fresh VM is where I expect small fixes. Send the output of any step that fails.
