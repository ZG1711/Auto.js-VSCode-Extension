import { EventEmitter } from 'events';
import * as ws from 'websocket';
import * as http from 'http';
import * as querystring from 'querystring';
import * as url from 'url';
import { Project, ProjectObserver } from './project';
import * as vscode from "vscode";
import Adb, { DeviceClient, Forward } from '@devicefarmer/adbkit';
import Tracker from '@devicefarmer/adbkit/dist/src/adb/tracker';
import ADBDevice from '@devicefarmer/adbkit/dist/src/Device';
import internal from "stream";
import buffer from "buffer";
import { _context } from "./extension";
import os from 'os';
import { AddressInfo } from "net";

const DEBUG = false;

function logDebug(message?: unknown, ...optionalParams: unknown[]) {
  if (DEBUG) {
    console.log(message, ...optionalParams);
  }
}



const HANDSHAKE_TIMEOUT = 10 * 1000;

export class Device extends EventEmitter {
  public name: string;
  public type: string;
  public id: string;
  private connection: ws.connection;
  public attached: boolean = false;
  public projectObserser: ProjectObserver;

  constructor(connection: ws.connection, type: string, id: string) {
    super();
    this.type = type
    this.id = id
    this.connection = connection;
    this.read(this.connection);
    this.on('data:hello', data => {
      logDebug("on client hello: ", data);
      this.attached = true;
      this.name = data['device_name'];
      const message_id = `${Date.now()}_${Math.random()}`;
      const appVersionCode = data['app_version_code']
      const extensionVersion = _context.extension.packageJSON.version
      let returnData
      if (appVersionCode >= 629) {
        returnData = JSON.stringify({ message_id, data: "ok", version: extensionVersion, debug: DEBUG, type: 'hello' })
      } else {
        returnData = JSON.stringify({ message_id, data: "连接成功", debug: DEBUG, type: 'hello' })
      }
      logDebug("return data: ", returnData)
      this.connection.sendUTF(returnData);
      this.emit("attach", this);
    });
    this.on('data:ping', data => {
      logDebug("on client ping: ", data);
      const returnData = JSON.stringify({ type: 'pong', data: data })
      logDebug("pong: ", returnData)
      this.connection.sendUTF(returnData);
    })
    setTimeout(() => {
      if (!this.attached) {
        console.log("handshake timeout");
        this.connection.close();
        this.connection = null;
      }
    }, HANDSHAKE_TIMEOUT);
  }

  close() {
    const message_id = `${Date.now()}_${Math.random()}`;
    const closeMessage = JSON.stringify({ message_id, data: "close", debug: false, type: 'close' })
    this.connection.sendUTF(closeMessage);
    this.connection.close();
    this.connection = null;
  }

  send(type: string, data: unknown): void {
    const message_id = `${Date.now()}_${Math.random()}`;
    console.log(data);
    this.connection.sendUTF(JSON.stringify({
      type: type,
      message_id,
      data: data
    }));
  }

  sendBytes(bytes: Buffer): void {
    this.connection.sendBytes(bytes);
  }

  sendBytesCommand(command: string, md5: string, data: object = {}): void {
    data = Object(data);
    data['command'] = command;
    const message_id = `${Date.now()}_${Math.random()}`;
    this.connection.sendUTF(JSON.stringify({
      type: 'bytes_command',
      message_id,
      md5: md5,
      data: data
    }));
  }

  sendCommand(command: string, data: object): void {
    data = Object(data);
    data['command'] = command;
    this.send('command', data);
  }

  public toString = (): string => {
    if (!this.name) {
      return `Device (${this.type}: ${this.id})`;
    }
    return `Device ${this.name}(${this.type}: ${this.id})`;
  }

  private read(connection: ws.connection) {
    connection.on('message', message => {
      logDebug("message: ", message);
      if (message.type == 'utf8') {
        try {
          const json = JSON.parse(message.utf8Data);
          logDebug("json: ", json);
          this.emit('message', json);
          this.emit('data:' + json['type'], json['data']);
        } catch (e) {
          console.error(e);
        }
      }
    });
    connection.on('close', (reasonCode, description) => {
      console.log(`close: device = ${this}, reason = ${reasonCode}, desc = ${description}`);
      this.connection = null;
      this.emit('disconnect');
    });
  }

}

export class AutoJsDebugServer extends EventEmitter {
  public isHttpServerStarted = false
  private httpServer: http.Server;
  public adbClient = Adb.createClient()
  private tracker: Tracker
  private port: number;
  public devices: Array<Device> = [];
  public project: Project = null;
  private logChannels: Map<string, vscode.OutputChannel>;
  private fileFilter = (relativePath: string, absPath: string) => {
    if (!this.project) {
      return true;
    }
    return this.project.fileFilter(relativePath, absPath);
  };

  constructor(port: number) {
    super();
    this.logChannels = new Map<string, vscode.OutputChannel>();
    this.port = port;
    this.httpServer = http.createServer((request, response) => {
      console.log(new Date() + ' Received request for ' + request.url);
      const urlObj = url.parse(request.url);
      const query = urlObj.query;
      const queryObj = querystring.parse(query);
      if (urlObj.pathname == "/exec") {
        response.writeHead(200);
        response.end("this commond is:" + queryObj.cmd + "-->" + queryObj.path);
        this.emit('cmd', queryObj.cmd, queryObj.path);
        console.log(queryObj.cmd, queryObj.path);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    const wsServer = new ws.server({ httpServer: this.httpServer, keepalive: true, keepaliveInterval: 10000 });
    wsServer.on('request', request => {
      const connection = request.accept();
      if (!connection) {
        return;
      }
      this.newDevice(connection, "tcp", connection.socket.remoteAddress + ":" + connection.socket.remotePort)
    })
  }

  getDeviceById(id: string): Device {
    return this.devices.find((value) => {
      return value.id == id
    })
  }

  private newDevice(connection: ws.connection, type: string, id: string) {
    const device = new Device(connection, type, id);
    logDebug(connection.state, "--->status")
    device
      .on("attach", (device) => {
        this.attachDevice(device);
        this.emit('new_device', device);
        const logChannel = this.newLogChannel(device);
        logChannel.appendLine(`Device connected: ${device}`);
      })
  }

  async adbShell(device: DeviceClient, command: string): Promise<string> {
    const duplex: internal.Duplex = await device.shell(command)
    const brandBuf: buffer.Buffer = await Adb.util.readAll(duplex)
    return brandBuf.toString()
  }

  private connectAutoxjsByADB(port: number, deviceId: string) {
    // 删除了不必要的autoJsDebugServer声明
    const url = `ws://localhost:${port}/`;
  
    const client = new ws.client();
  
    client.on('connectFailed', (error) => {
      // 直接在这里使用 this
      const err = 'Connect Error: ' + error.toString();
      console.log(err);
      vscode.window.showInformationMessage(err);
    });
  
    client.on('connect', (connection) => {
      // 直接在这里使用 this
      console.log("connected to " + url);
      this.newDevice(connection, "adb", deviceId);
    });
    client.connect(url);
  }
  
  listen(): void {
    if (this.isHttpServerStarted) {
      this.emit("connected");
      return
    }
    this.httpServer.on('error', (e) => {
      this.isHttpServerStarted = false
      console.error('server error: ', e);
    });
    this.httpServer.listen(this.port, '0.0.0.0', () => {
      this.isHttpServerStarted = true
      const address = this.httpServer.address() as AddressInfo;
      const localAddress = this.getIPAddress();
      console.log(`server listening on ${localAddress}:${address.port} / ${address.address}:${address.port}`);
      this.emit("connect");
    });
  }


  async listADBDevices(): Promise<ADBDevice[]> {
    return this.adbClient.listDevices();
  }

  async trackADBDevices() {
    // 删除了不必要的thisServer声明
    const devices = await this.adbClient.listDevices();
    for (const device0 of devices) {
      await this.connectDevice(device0.id);
    }
    if (this.tracker) {
      this.emit("adb:tracking_started");
      return;
    }
    try {
      const tracker = await this.adbClient.trackDevices();
      this.tracker = tracker;
      tracker.on('add', async (device0) => {
        console.log("adb device " + device0.id + " added");
        const device = this.adbClient.getDevice(device0.id);
        await device.waitForDevice();
        await this.connectDevice(device0.id, device);
      });
      tracker.on('remove', (device) => {
        console.log("adb device " + device.id + " removed");
        const wsDevice = this.getDeviceById(device.id);
        if (wsDevice) {
          wsDevice.close();
        }
      });
      tracker.on('end', () => {
        // 直接在这里使用 this
        this.tracker = undefined;
        console.log('ADB Tracking stopped');
        this.emit("adb:tracking_stop");
      });
    } catch (err) {
      this.tracker = undefined;
      this.emit("adb:tracking_error");
      console.error('ADB error: ', err.stack);
    }
  
    this.emit("adb:tracking_start");
  }
  async connectDevice(id: string, device: DeviceClient = undefined) {
    if (!device) device = this.adbClient.getDevice(id)
    const wsDevice = this.getDeviceById(id)
    if (wsDevice && wsDevice.attached) return
    let forwards: Forward[] = await this.listForwards(device, id)
    if (forwards.length == 0) {
      const forwarded = await device.forward(`tcp:0`, `tcp:9317`)
      if (forwarded) {
        forwards = await this.listForwards(device, id)
      }
    }
    if (forwards.length > 0) {
      const forward = forwards[0]
      console.log(`forward ${id}: local -> ${forward.local}, remote -> ${forward.remote}`)
      const port = Number(forward.local.replace("tcp:", ""))
      this.connectAutoxjsByADB(port, id)
    }
  }

  private async listForwards(device: DeviceClient, id: string): Promise<Forward[]> {
    const forwards: Forward[] = await device.listForwards()
    return forwards.filter((forward) => {
      return forward.serial == id && forward.remote == "tcp:9317"
    })
  }

  stopTrackADBDevices() {
    if (this.tracker) {
      this.tracker.end()
      this.tracker = undefined
    }
  }

  send(type: string, data: unknown): void {
    this.devices.forEach(device => {
      device.send(type, data);
    });
  }

  sendBytes(data: Buffer): void {
    this.devices.forEach(device => {
      device.sendBytes(data);
    });
  }

  sendBytesCommand(command: string, md5: string, data: object = {}): void {
    this.devices.forEach(device => {
      device.sendBytesCommand(command, md5, data);
    });
  }

  sendProjectCommand(folder: string, command: string) {
    const startTime = new Date().getTime();
    this.devices.forEach(device => {
      if (device.projectObserser == null || device.projectObserser.folder != folder) {
        device.projectObserser = new ProjectObserver(folder, this.fileFilter);
      }
      device.projectObserser.diff()
        .then(result => {
          device.sendBytes(result.buffer);
          device.sendBytesCommand(command, result.md5, {
            'id': folder,
            'name': folder
          });
          this.getLogChannel(device).appendLine(`发送项目耗时: ${(new Date().getTime() - startTime) / 1000} 秒`);
        });
    });
  }

  sendCommand(command: string, data: object = {}): void {
    this.devices.forEach(device => {
      device.sendCommand(command, data);
    });
  }

  disconnect(): void {
    this.httpServer.close();
    this.isHttpServerStarted = false
    this.emit("disconnect");
    this.logChannels.forEach(channel => {
      channel.dispose();
    });
    this.logChannels.clear();
    this.devices.forEach((device) => {
      device.close()
    })
  }

  /** 获取本地IP */
  getIPAddress(): string {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
      const iface = interfaces[devName];
      for (let i = 0; i < iface.length; i++) {
        const alias = iface[i];
        if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
          return alias.address;
        }
      }
    }
    return '127.0.0.1';
  }
  /** 获取本地IP */
  getIPs(): string[] {
    const ips = [];
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
      const iface = interfaces[devName];
      for (let i = 0; i < iface.length; i++) {
        const alias = iface[i];
        console.log("---", alias)
        if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
          ips.push(alias.address);
        }
      }
    }
    return ips;
  }

  /** 获取服务运行端口 */
  getPort(): number {
    return this.port;
  }

  private attachDevice(device: Device): void {
    this.devices.push(device);
    device.on('data:log', data => {
      console.log(data['log']);
      this.getLogChannel(device).appendLine(data['log']);
      this.emit('log', data['log']);
    });
    device.on('disconnect', this.detachDevice.bind(this, device));
  }

  private detachDevice(device: Device): void {
    this.devices.splice(this.devices.indexOf(device), 1);
    console.log("detachDevice: " + device);
    vscode.window.showInformationMessage(`Device disconnected: ${device}`)
    const logChannel = this.getLogChannel(device)
    logChannel.dispose();
    this.logChannels.delete(device.toString())
  }

  /** 创建设备日志打印通道 */
  private newLogChannel(device: Device): vscode.OutputChannel {
    const channelName = device.toString();
    // let logChannel = this.logChannels.get(channelName);
    // if (!logChannel) {
    const logChannel = vscode.window.createOutputChannel(channelName);
    this.logChannels.set(channelName, logChannel);
    // }
    logChannel.show(true);
    // console.log("创建日志通道" + channelName)
    return logChannel;
  }

  /** 获取设备日志打印通道 */
  getLogChannel(device: Device): vscode.OutputChannel {
    const channelName = device.toString();
    // console.log("获取日志通道：" + channelName);
    return this.logChannels.get(channelName);
  }

}
