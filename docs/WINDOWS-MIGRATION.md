# Windows Server 2025 migration

1. Finish or stop active Nimbus tasks and create a backup. Export the recovery key separately.
2. Install Node.js, the Codex CLI, LM Studio/its CLI and a suitable NVIDIA driver on the destination. Confirm that local GPU inference works under the Windows account that will run Nimbus. Headless browser operation does not require a separate desktop VM.
3. Copy this source checkout, install its locked dependencies with `npm ci`, and run `npm run browser:install`.
4. Restore the encrypted archive into an empty directory. Move the restored `data/` and `nimbus.config.json` into the destination checkout. Keep the source copies until verification is complete.
5. Update machine-specific executable and endpoint paths in `nimbus.config.json`. Native model files must be installed on that host; the backup does not include LM Studio model weights. The restored local-token file is protected for the destination Windows account.
6. Run `Setup-Nimbus.ps1` to create destination dashboard credentials without overwriting restored state. Run `codex login` on the destination; Nimbus does not migrate or export native Codex authentication.
7. Run the doctor, automated checks and live acceptance tasks. Confirm actual model IDs, local loading, resource ceilings, separate browser groups and restored artifacts. Review interrupted tasks before resuming them; unresolved actions stay held.
8. Configure the desired host binding, TLS and firewall. If sign-in startup is appropriate, run `Install-NimbusStartup.ps1` under the service account. The supplied startup task uses an interactive user logon, not a Windows service identity; unattended boot without sign-in needs a separately validated service deployment.

Hyper-V is optional for future isolated desktop workers. It is not a prerequisite for the worker runtime or browser groups.

The source backup remains the rollback point. Keep the previous installation stopped while testing the restored copy to avoid running the same scheduled jobs on both machines.
