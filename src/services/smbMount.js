// SMB mounting via macOS's native `mount_smbfs`.
//
// The media lives on a password-protected Samba share. Rather than pull in an
// SMB npm library, we shell out to the OS client so `ffprobe` sees ordinary
// local files under the mount point. This is macOS-specific by design — the
// deployment target is the Mac that runs OnTheAir Video.
//
// SECURITY NOTE: SMB credentials live in plaintext in config/config.json. That
// is an accepted tradeoff for a self-contained, offline, USB-copyable app with
// no secrets manager — but the config file should not be committed to a shared
// repo or left on an unattended drive.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Is the configured mount point already mounted? Cheap check: the directory
 * exists and is non-empty. `mount_smbfs` refuses to mount onto a non-empty dir,
 * so a populated mount point means it's already attached (or occupied).
 */
export function isMounted(mountPoint) {
  try {
    return existsSync(mountPoint) && readdirSync(mountPoint).length > 0;
  } catch {
    return false;
  }
}

/**
 * Mount the SMB share described by config.smb at config.smb.mountPoint.
 * Returns { mounted: true, alreadyMounted?: true } or throws with stderr.
 */
export async function mountShare(smb) {
  const { host, share, username, password, mountPoint } = smb;
  if (!host || !share || !mountPoint) {
    throw new Error('smb config requires host, share, and mountPoint');
  }
  if (isMounted(mountPoint)) {
    return { mounted: true, alreadyMounted: true };
  }

  mkdirSync(mountPoint, { recursive: true });

  // //user:password@host/share  — credentials are URL-encoded to survive
  // characters like @ or / inside the password.
  const cred =
    username && password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : '';
  const url = `//${cred}${host}/${share}`;

  if (process.platform !== 'darwin') {
    throw new Error(
      `mount_smbfs is macOS-only; current platform is "${process.platform}". ` +
        'On the deployment Mac this will mount ' + url + ' at ' + mountPoint + '.'
    );
  }

  await execFileAsync('mount_smbfs', [url, mountPoint]);
  return { mounted: true };
}
