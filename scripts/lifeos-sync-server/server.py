#!/usr/bin/env python3
"""LifeOS Sync Server - 多用户同步注册 API

单文件 Flask 应用，负责用户注册/登录和设备管理。
通过 Syncthing REST API 自动创建文件夹和添加设备。
"""

import hashlib
import json
import os
import secrets
import subprocess
import sys
from datetime import date
from pathlib import Path

import bcrypt
import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DATA_DIR = Path("/opt/lifeos-sync-server")
USERS_FILE = DATA_DIR / "users.json"
SYNCTHING_API = "http://127.0.0.1:8384"
SYNCTHING_CONFIG = Path("/home/syncthing/.local/share/syncthing/config.xml")
VAULTS_BASE = Path("/home/syncthing/vaults")
PORT = 8385

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------


def get_syncthing_api_key() -> str:
    """从 Syncthing config.xml 中读取 API Key"""
    import re
    text = SYNCTHING_CONFIG.read_text(encoding="utf-8")
    m = re.search(r"<apikey>(.*?)</apikey>", text)
    if not m:
        raise RuntimeError("无法从 config.xml 读取 API Key")
    return m.group(1)


def get_server_device_id() -> str:
    """获取服务器 Syncthing 设备 ID"""
    key = get_syncthing_api_key()
    resp = requests.get(
        f"{SYNCTHING_API}/rest/system/status",
        headers={"X-API-Key": key},
        timeout=5,
    )
    resp.raise_for_status()
    return resp.json()["myID"]


def st_api(method: str, path: str, body: dict | None = None) -> requests.Response:
    """调用 Syncthing REST API"""
    key = get_syncthing_api_key()
    url = f"{SYNCTHING_API}{path}"
    headers = {"X-API-Key": key, "Content-Type": "application/json"}
    resp = requests.request(method, url, headers=headers, json=body, timeout=10)
    return resp


def generate_folder_id(username: str) -> str:
    """确定性生成 folder ID: lifeos- + SHA256(username) 前 8 位"""
    h = hashlib.sha256(username.encode()).hexdigest()[:8]
    return f"lifeos-{h}"


def load_users() -> dict:
    if USERS_FILE.exists():
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    return {}


def save_users(users: dict):
    USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")


def find_user_by_token(users: dict, token: str) -> str | None:
    """根据 token 查找用户名"""
    for username, info in users.items():
        if info.get("token") == token:
            return username
    return None


def ensure_vault_dir(vault_path: Path):
    """创建 vault 目录和 .stfolder 标记"""
    vault_path.mkdir(parents=True, exist_ok=True)
    stfolder = vault_path / ".stfolder"
    stfolder.mkdir(exist_ok=True)
    # 确保 syncthing 用户拥有目录
    subprocess.run(["chown", "-R", "syncthing:syncthing", str(vault_path)], check=False)


def create_syncthing_folder(folder_id: str, vault_path: str, device_ids: list[str]):
    """在服务器 Syncthing 中创建文件夹"""
    server_id = get_server_device_id()
    devices = [{"deviceID": server_id, "introducedBy": "", "encryptionPassword": ""}]
    for did in device_ids:
        devices.append({"deviceID": did, "introducedBy": "", "encryptionPassword": ""})

    body = {
        "id": folder_id,
        "label": "LifeOS Vault",
        "path": vault_path,
        "type": "sendreceive",
        "devices": devices,
        "rescanIntervalS": 60,
        "fsWatcherEnabled": True,
        "fsWatcherDelayS": 10,
        "ignorePerms": False,
        "autoNormalize": True,
        "paused": False,
        "versioning": {
            "type": "simple",
            "params": {"keep": "5", "cleanoutDays": "30"},
            "cleanupIntervalS": 3600,
        },
    }
    resp = st_api("POST", "/rest/config/folders", body)
    if resp.status_code == 200:
        return True
    # 可能已存在，尝试更新
    resp2 = st_api("PUT", f"/rest/config/folders/{folder_id}", body)
    return resp2.status_code == 200


def add_device_to_syncthing(device_id: str, device_name: str):
    """在服务器 Syncthing 中添加设备"""
    body = {
        "deviceID": device_id,
        "name": device_name,
        "addresses": ["dynamic"],
        "compression": "metadata",
        "introducer": False,
        "autoAcceptFolders": False,
    }
    resp = st_api("POST", "/rest/config/devices", body)
    # 200 = 成功, 可能已存在也算成功
    return resp.status_code in (200, 201)


def add_device_to_folder(folder_id: str, device_id: str):
    """将设备加入 Syncthing 文件夹"""
    resp = st_api("GET", f"/rest/config/folders/{folder_id}")
    if resp.status_code != 200:
        return False
    folder = resp.json()
    devices = folder.get("devices", [])
    # 检查是否已存在
    for d in devices:
        if d.get("deviceID") == device_id:
            return True
    devices.append({"deviceID": device_id, "introducedBy": "", "encryptionPassword": ""})
    folder["devices"] = devices
    resp2 = st_api("PUT", f"/rest/config/folders/{folder_id}", folder)
    return resp2.status_code == 200


# ---------------------------------------------------------------------------
# API 路由
# ---------------------------------------------------------------------------


@app.route("/api/status", methods=["GET"])
def status():
    """健康检查"""
    try:
        device_id = get_server_device_id()
        return jsonify({"ok": True, "server_device_id": device_id})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/register", methods=["POST"])
def register():
    """注册新用户"""
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"error": "用户名和密码不能为空"}), 400
    if len(username) < 2 or len(username) > 32:
        return jsonify({"error": "用户名长度需 2-32 个字符"}), 400
    if len(password) < 4:
        return jsonify({"error": "密码至少 4 个字符"}), 400
    if not username.isalnum():
        return jsonify({"error": "用户名只能包含字母和数字"}), 400

    users = load_users()
    if username in users:
        return jsonify({"error": "用户名已存在，请直接登录"}), 409

    # 生成用户配置
    folder_id = generate_folder_id(username)
    vault_path = str(VAULTS_BASE / username)
    token = secrets.token_hex(32)
    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

    # 创建 vault 目录
    ensure_vault_dir(VAULTS_BASE / username)

    # 在 Syncthing 中创建文件夹
    try:
        create_syncthing_folder(folder_id, vault_path, [])
    except Exception as e:
        return jsonify({"error": f"创建同步文件夹失败：{e}"}), 500

    # 保存用户
    users[username] = {
        "password_hash": password_hash,
        "token": token,
        "folder_id": folder_id,
        "vault_path": vault_path,
        "devices": [],
        "created_at": str(date.today()),
    }
    save_users(users)

    server_device_id = get_server_device_id()
    return jsonify({
        "token": token,
        "folder_id": folder_id,
        "server_device_id": server_device_id,
        "username": username,
    })


@app.route("/api/login", methods=["POST"])
def login():
    """用户登录"""
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"error": "用户名和密码不能为空"}), 400

    users = load_users()
    user = users.get(username)
    if not user:
        return jsonify({"error": "用户不存在，请先注册"}), 404

    if not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
        return jsonify({"error": "密码错误"}), 401

    # 刷新 token
    token = secrets.token_hex(32)
    user["token"] = token
    users[username] = user
    save_users(users)

    server_device_id = get_server_device_id()
    return jsonify({
        "token": token,
        "folder_id": user["folder_id"],
        "server_device_id": server_device_id,
        "username": username,
    })


@app.route("/api/device", methods=["POST"])
def add_device():
    """注册设备到用户的同步文件夹"""
    # 验证 token
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return jsonify({"error": "缺少认证 token"}), 401
    token = auth[7:]

    users = load_users()
    username = find_user_by_token(users, token)
    if not username:
        return jsonify({"error": "token 无效或已过期，请重新登录"}), 401

    data = request.get_json(force=True)
    device_id = (data.get("device_id") or "").strip()
    device_name = (data.get("device_name") or "新设备").strip()

    if not device_id:
        return jsonify({"error": "device_id 不能为空"}), 400

    user = users[username]
    folder_id = user["folder_id"]

    # 在 Syncthing 中添加设备
    try:
        add_device_to_syncthing(device_id, device_name)
        add_device_to_folder(folder_id, device_id)
    except Exception as e:
        return jsonify({"error": f"配置 Syncthing 失败：{e}"}), 500

    # 记录设备
    if device_id not in user["devices"]:
        user["devices"].append(device_id)
        users[username] = user
        save_users(users)

    return jsonify({"ok": True, "folder_id": folder_id})


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    VAULTS_BASE.mkdir(parents=True, exist_ok=True)
    print(f"LifeOS Sync Server 启动于 0.0.0.0:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
