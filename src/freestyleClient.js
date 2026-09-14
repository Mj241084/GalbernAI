export function getSandboxUrl(vmId, path, action = "read") {
  const encPath = encodeURIComponent(path.startsWith("/") ? path : `/${path}`);
  if (action === "write") {
    return `https://beta-api.freestyle.sh/v5/vms/${vmId}/fs/write?path=${encPath}`;
  }
  return `https://beta-api.freestyle.sh/v5/vms/${vmId}/fs/read?path=${encPath}`;
}

export function getSandboxExecUrl(vmId) {
  return `https://beta-api.freestyle.sh/v5/vms/${vmId}/exec-await`;
}

export async function freestyleReadFile(env, vmId, path) {
  const url = getSandboxUrl(vmId, path, "read");
  const apiKey = env.FREESTYLE_API_KEY;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 1 minute read timeout

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function freestyleWriteFile(env, vmId, path, data) {
  const url = getSandboxUrl(vmId, path, "write");
  const apiKey = env.FREESTYLE_API_KEY;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 1 minute write timeout

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/octet-stream"
      },
      body: data,
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`freestyle write failed with status ${res.status}: ${errText}`);
    }
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function freestyleExec(env, vmId, command) {
  const url = getSandboxExecUrl(vmId);
  const apiKey = env.FREESTYLE_API_KEY;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 minutes exec timeout

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ command }),
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`freestyle exec failed with status ${res.status}: ${errText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}
