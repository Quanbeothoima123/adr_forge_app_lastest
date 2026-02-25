// src/controller/groupManager.js
class GroupManager {
  constructor(initialGroups = []) {
    this.groups = new Map(); // groupId -> { id, name, devices:Set<string> }

    if (Array.isArray(initialGroups)) {
      for (const g of initialGroups) {
        const id = String(g?.id || "").trim();
        if (!id) continue;
        const name = String(g?.name || id);
        const devs = new Set(
          Array.isArray(g?.devices) ? g.devices.map((x) => String(x)) : []
        );
        this.groups.set(id, { id, name, devices: devs });
      }
    }
  }

  create(id, name) {
    const gid = String(id || "").trim();
    if (!gid) throw new Error("group id required");
    if (this.groups.has(gid)) return this.groups.get(gid);

    const g = { id: gid, name: name ? String(name) : gid, devices: new Set() };
    this.groups.set(gid, g);
    return g;
  }

  rename(id, name) {
    const g = this.groups.get(String(id || ""));
    if (!g) throw new Error("group not found");
    g.name = String(name || g.id);
    return g;
  }

  remove(id) {
    this.groups.delete(String(id || ""));
  }

  get(id) {
    return this.groups.get(String(id || "")) || null;
  }

  addDevice(groupId, deviceId) {
    const g = this.get(groupId);
    if (!g) throw new Error("group not found");
    const did = String(deviceId || "").trim();
    if (!did) throw new Error("device id required");
    g.devices.add(did);
    return true;
  }

  removeDevice(groupId, deviceId) {
    const g = this.get(groupId);
    if (!g) return false;
    g.devices.delete(String(deviceId || "").trim());
    return true;
  }

  list() {
    return Array.from(this.groups.values()).map((g) => ({
      id: g.id,
      name: g.name,
      devices: Array.from(g.devices),
    }));
  }

  toJSON() {
    return this.list();
  }
}

module.exports = { GroupManager };

