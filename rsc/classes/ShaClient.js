'use strict';

const { ChildProcess } = require("child_process");
const { Client, User, Guild, Collection } = require("discord.js");
const { join } = require("path");
const requireAll = require("require-all");
const { ShaBaseDb } = require("./Database");
const { adCheck, cleanMentionID, createRegExp } = require("../functions");
const { escapeRegExp } = require("lodash");
const { logDev } = require("../debug");

module.exports = class ShaClient extends Client {
    constructor(options) {
        super(options);
        /**
         * @type {User[]}
         */
        this.owners = [];
        this.eventHandlers = null;
        this.handlers = null;
        this.commands = null;
        this.selectMenus = null;
        this.functions = null;
        this.handledCommands = new Map();
        this.activeSelectMenus = new Map();
        this.loadedListeners = {};
        /**
         * @type {ChildProcess}
         */
        this.dashboard = options.dashboard || null;
        /**
         * @type {ShaBaseDb}
         */
        this.db = options.db || null;
    }

    dispatch() {
        try {
            this.unloadModules();
            this.loadModules();
            this.dispatchListeners("on");
            this.dispatchDashboard();
            this.loadDbSelectMenus();
        } catch (e) { process.emit("error", e) }
    }

    loadModules() {
        this.eventHandlers = requireAll({ dirname: join(__dirname, "../eventHandlers") });
        this.handlers = requireAll({ dirname: join(__dirname, "../handlers") });
        this.commands = requireAll({ dirname: join(__dirname, "../cmds"), recursive: true });
        this.selectMenus = requireAll({ dirname: join(__dirname, "../selectMenus"), recursive: true });
        this.functions = require("../functions");
        logDev("Modules unload/load done");
    }

    unloadModules() {
        const modulesDirName = ["../eventHandlers", "../handlers", "../cmds", "../selectMenus"];
        const modulesName = ["../functions.js"];
        const modulesDirPath = modulesDirName.map(r => join(__dirname, r));
        modulesDirPath.push(...modulesName.map(r => join(__dirname, r)));
        this.dispatchListeners();
        for (const R in require.cache) {
            if (modulesDirPath.some(r => new RegExp("^" + escapeRegExp(r)).test(R))) {
                delete require.cache[R];
                logDev("unloaded module:", R);
            }
        }
    }

    /**
     * 
     * @param {"off"|"on"} opt
     */
    dispatchListeners(opt = "off") {
        if (opt !== "on" && opt !== "off") throw new TypeError("Expected 'on' or 'off'. Got " + opt);
        let count = 0;
        for (const U in this.eventHandlers) {
            if (opt === "on") this.loadedListeners[U] = async (...args) => {
                logDev("[ EVENT", U, "]", ...args);
                this.eventHandlers[U].handle(this, ...args);
            }
            this[opt](U, this.loadedListeners[U]);
            logDev("Listener", U, (opt === "on" ? "dispatched" : "removed"));
            count++;
        }
        logDev(count, `listeners ${opt === "off" ? "un" : ""}loaded`);
    }

    dispatchDashboard() {
        if (this.dashboard instanceof ChildProcess) {
            this.dashboard.on("spawn", () =>
                console.log("Dashboard initialized..."));

            this.dashboard.on("message", (msg, sendHandle) =>
                console.log("[ DASHBOARD_MESSAGE ]\n%s", msg,
                    "SEND_HANDLE:\n%s", sendHandle), "\n[ END:DASHBOARD_MESSAGE ]");

            this.dashboard.on("exit", (c, s) =>
                console.warn("[ DASHBOARD_EXIT ]\n%s", "CODE:", c, "SIG:\n%s", s, "\n[ END:DASHBOARD_EXIT ]"));

            this.dashboard.on("error", (e) =>
                console.error("[ DASHBOARD_ERROR ]\n%s", e, "\n[ END:DASHBOARD_ERROR ]"));

            this.dashboard.on("disconnect", () =>
                console.warn("Dashboard got disconnected..."));

            this.dashboard.on("close", (c, s) =>
                console.warn("[ DASHBOARD_CLOSED ]\n%s", "CODE:", c, "SIG:\n%s", s, "\n[ END:DASHBOARD_CLOSED ]"));

            // this.dashboard.stdout.on("data", (c) =>
            //     console.log("[ DASHBOARD_STDOUT ]\n%s", c, "\n[ END:DASHBOARD_STDOUT ]"));

            // this.dashboard.stderr.on("data", (c) =>
            //     console.log("[ DASHBOARD_STDERR ]\n%s", c, "\n[ END:DASHBOARD_STDERR ]"));
        }
    }

    /**
     * Emotify str and check for ads
     * @param {string} str 
     * @param {boolean} noAdCheck 
     * @returns {string}
     */
    finalizeStr(str, noAdCheck = false) {
        let ret = this.emoteMessage(str);
        if (!noAdCheck) ret = adCheck(ret);
        return ret;
    }

    /**
     * 
     * @param {string} id
     * @param {*} val - Value
     * @param {number|boolean} timeout - Delete in ms
     * @returns 
     */
    async createSelectMenu(id, val, timeout = true) {
        const ret = this.activeSelectMenus.set(id, val);
        if (timeout === true) timeout = 60 * 1000 * 15;
        if (typeof timeout === "number" && timeout > 0)
            setTimeout(() => this.activeSelectMenus.delete(id), timeout);
        else {
            await this.db.set("activeSelectMenus", id, val);
        }
        return ret;
    }

    async loadDbSelectMenus() {
        const get = await this.db.get("activeSelectMenus", String);
        if (get.size)
            for (const [k, v] of get)
                this.activeSelectMenus.set(k, v);
    }

    async deleteSelectMenu(id) {
        this.activeSelectMenus.delete(id);
        return this.db.delete("activeSelectMenus", id);
    }

    /**
     * Check if user is this owner
     * @param {User | GuildMember | string} user
     * @returns {boolean}
     */
    isOwner(user) {
        if (user.id && /^\d{18,20}$/.test(user.id)) user = user.id;
        if (typeof user !== "string" || (typeof user === "string" && !/^\d{18,20}$/.test(user)))
            throw new TypeError("user is " + user);
        return this.owners.some(r => r.id === user);
    }

    /**
     * Find guild with id or exact name, force will use RegExp
     * @param {string} query
     * @param {string} reFlags - RegExp flags (force)
     * @param {boolean} force
     * @returns {Collection<string, Guild> | Guild}
     */
    findGuilds(query, reFlags, force = false) {
        if (typeof query !== "string") throw new TypeError("query must be a string!");
        query = cleanMentionID(query);
        if (!query) return;
        if (/^\d{18,20}$/.test(query))
            return this.guilds.resolve(query);
        else if (force) {
            const re = createRegExp(query, reFlags);
            return this.guilds.cache.filter(v =>
                re.test(v.name)
            );
        } else {
            return this.guilds.cache.filter(v =>
                v.name === query
            );
        }
    }

    /**
     * @param {string} query 
     * @param {string} reFlags 
     * @returns {Collection<string, User> | Promise<User>}
     */
    async findUsers(query, reFlags) {
        if (typeof query !== "string") throw new TypeError("query must be a string!");
        query = cleanMentionID(query);
        if (!query) return;
        if (/^\d{18,20}$/.test(query)) {
            let u = this.users.resolve(query);
            if (!u) u = await this.users.fetch(query).catch(() => { });
            return u;
        } else {
            const re = createRegExp(query, reFlags);
            return this.users.cache.filter(r =>
                re.test(r.username) || re.test(r.tag));
        }
    }

    emoteMessage(content) {
        const E = content?.match(/:\w{1,32}:(?!\d{18,20}>)/g);
        if (!E || !E.length) return content;
        const tE = [];
        for (const eN of E) {
            const findThis = eN.slice(1, -1).toLowerCase();
            const found = this.emojis.cache.filter(r => r.name.toLowerCase() === findThis).first();
            tE.push(found);
        }
        if (tE.length && tE.some(r => !!r)) {
            for (let index = 0; index < E.length; index++) {
                if (!tE[index]) continue;
                content = content.replace(E[index], `<${tE[index].animated ? "a" : ""}:${tE[index].name}:${tE[index].id}>`);
            }
        }
        return content;
    }

    async loadBannedGuilds() {
        if (this.bannedGuilds) return this.bannedGuilds;
        const get = await this.db.getOne("bannedGuilds", "String[]");
        return this.bannedGuilds = get?.value || [];
    }

    async loadBannedUsers() {
        if (this.bannedUsers) return this.bannedUsers;
        const get = await this.db.getOne("bannedUsers", "String[]");
        return this.bannedUsers = get?.value || [];
    }

    /**
     * 
     * @param {Guild} guild 
     * @returns 
     */
    async banGuild(guild) {
        await this.loadBannedGuilds();
        const id = Array.isArray(guild) ? guild : [guild];
        const banned = [];
        const already = [];
        const error = [];
        for (let r of id) {
            const ori = r;
            if (r instanceof Guild) r = r.id;
            if (typeof r !== "string") {
                error.push("Expected string. Got " + typeof id + " of " + r);
                continue;
            };
            if (!/^\d{18,20}$/.test(r)) {
                error.push("Invalid id: " + r);
                continue;
            };
            if (this.bannedGuilds.includes(r)) {
                if (!already.some(a => (a.id || a) === r)) already.push(ori);
                continue;
            }
            this.bannedGuilds.push(r);
            banned.push(ori);
        };
        const db = await this.db.set("bannedGuilds", "String[]", { value: this.bannedGuilds });
        return { banned, already, error, db };
    }

    async banUser(user) {
        await this.loadBannedUsers();
        const id = Array.isArray(user) ? user : [user];
        const banned = [];
        const already = [];
        const error = [];
        for (let r of id) {
            const ori = r;
            if (r instanceof User) r = r.id;
            if (typeof r !== "string") {
                error.push("Expected string. Got " + typeof id + " of " + r);
                continue;
            };
            if (!/^\d{18,20}$/.test(r)) {
                error.push("Invalid id: " + r);
                continue;
            };
            if (this.bannedUsers.includes(r)) {
                if (!already.some(a => (a.id || a) === r)) already.push(ori);
                continue;
            }
            this.bannedUsers.push(r);
            banned.push(ori);
        };
        const db = await this.db.set("bannedUsers", "String[]", { value: this.bannedUsers });
        return { banned, already, error, db };
    }

    async unbanGuild(guild) {
        await this.loadBannedGuilds();
        const unbanned = [];
        const already = [];
        const id = Array.isArray(guild) ? guild : [guild];
        for (let r of id) {
            const ori = r;
            if (r instanceof Guild) r = r.id;
            if (!this.bannedGuilds.includes(r)) {
                if (!already.some(a => (a.id || a) === r)) already.push(ori);
                continue;
            }
            this.bannedGuilds.splice(this.bannedGuilds.indexOf(r), 1);
            unbanned.push(ori);
        }
        const db = await this.db.set("bannedGuilds", "String[]", { value: this.bannedGuilds });
        return { unbanned, already, db };
    }

    async unbanUser(user) {
        await this.loadBannedUsers();
        const unbanned = [];
        const already = [];
        const id = Array.isArray(user) ? user : [user];
        for (let r of id) {
            const ori = r;
            if (r instanceof User) r = r.id;
            if (!this.bannedUsers.includes(r)) {
                if (!already.some(a => (a.id || a) === r)) already.push(ori);
                continue;
            }
            this.bannedUsers.splice(this.bannedUsers.indexOf(r), 1);
            unbanned.push(ori);
        }
        const db = await this.db.set("bannedUsers", "String[]", { value: this.bannedUsers });
        return { unbanned, already, db };
    }
}