import { ParameterError, ServerError } from "../../../types/error";
import { toId } from "../../modules/Utils";
import { IDbMod } from "../models";
import ModDAO from "../../modules/dao/ModDAO";
const md5 = require("md5");
import fs from "fs";
import path from "path";
const StreamZip = require("node-stream-zip");
import AuditLogService from "./AuditLogService";
import DiscordManager from "../../modules/DiscordManager";
const openpgp = require("openpgp");
let privkey;
export default class ModService {
    constructor(protected ctx: IContext) {
        this.dao = new ModDAO(this.ctx.db);
    }
    protected dao: ModDAO;

    public async insert(mod: IDbMod) {
        if (mod._id) {
            return null;
        }
        const _id = await this.dao.insert(mod as any);
        new AuditLogService(this.ctx).create(this.ctx.user, "INSERT", "MOD", {}, mod);
        new DiscordManager().sendWebhook(
            `${this.ctx.user.username} uploaded ${mod.name} v${mod.version}`,
            Object.keys(mod)
                .filter(i => i === "description")
                .map(i => ({ name: i, value: mod[i] })) as dynamic[],
            "https://beatmods.com"
        );

        return { _id, ...mod } as IDbMod;
    }
    public async find(query: dynamic) {
        return (await this.dao.find(query)[0]) as (IDbMod | null);
    }

    public async get(_id: string | Id) {
        return (await this.dao.get(toId(_id))[0]) as (IDbMod | null);
    }

    public async remove(_id: string | Id) {
        return await this.dao.remove(_id);
    }

    private getRegex(param: string) {
        return {
            $regex: `${decodeURIComponent(param).replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&")}`,
            $options: "i"
        };
    }
    public async list(params?: any) {
        const query: dynamic = {};
        let sort: dynamic | undefined;
        if (params && Object.keys(params).length) {
            if (params.search && params.search.length) {
                query.$or = [{ name: this.getRegex(params.search) }, { description: this.getRegex(params.search) }, { "author.username": this.getRegex(params.search) }];
            }
            if (params.hash && params.hash.length) {
                query["downloads.hashMd5.hash"] = params.hash;
            }
            const fields = { category: "category", status: "status", name: "name", version: "version", author: "author.username" };
            for (const field in fields) {
                if (params[field] && params[field].length) {
                    if (Array.isArray(params[field])) {
                        query[fields[field]] = { $in: params[field] };
                    } else {
                        query[fields[field]] = this.getRegex(params[field]);
                    }
                }
            }
            if (params.sort) {
                sort = { [params.sort]: Number(params.sortDirection || 1), required: 1 };
            }
        }
        const cursor = await this.dao.list(Object.keys(query).length ? query : undefined, sort ? { sort } : undefined);

        const mods = await cursor.toArray();
        if (this.ctx.user && this.ctx.user._id) {
            const personalCursor = await this.dao.list({
                authorId: toId(this.ctx.user._id),
                status: { $nin: ["approved", "inactive"] }
            });
            const personalMods = await personalCursor.toArray();
            for (const mod of personalMods) {
                if (mods.filter(m => m._id === mod._id).length === 0) {
                    mods.push(mod);
                }
            }
        }
        return mods.map(mod => mod as IDbMod);
    }

    public async update(mod: IDbMod, isInsert = false) {
        if (!mod._id) {
            throw new ParameterError("mod._id");
        }
        const existing = await this.dao.get(toId(mod._id));
        if (!this.ctx.user || (!this.ctx.user.admin && toId(mod.authorId).toHexString() !== toId(this.ctx.user._id).toHexString())) {
            throw new ServerError("mod.no_permissions");
        }

        const updateMod: Partial<IDbMod> = {};
        const authenticationProps = ["status", "required"];
        for (const prop in mod) {
            if (prop in mod) {
                if (prop in authenticationProps && !(this.ctx.user && this.ctx.user.admin)) {
                    throw new ParameterError(`mod.auth_required.${prop}`);
                }
                updateMod[prop] = mod[prop];
            }
        }
        if (Object.keys(updateMod).length === 0) {
            return new ParameterError(`mod.no_properties_updated`);
        }
        updateMod["updatedDate"] = new Date();
        if (updateMod.dependencies && typeof updateMod.dependencies === "string") {
            updateMod.dependencies = (await this.dao.getDependencies(updateMod.dependencies)).map(item => toId(item._id));
        }
        if (updateMod.status && updateMod.status === "approved") {
            const older = await this.dao.getOldVersions(existing);
            await this.dao.updateMatch({ _id: { $in: older.map(i => toId(i._id)) } }, { status: "inactive" });
        }
        if (updateMod["_id"]) {
            delete updateMod["_id"];
        }
        new AuditLogService(this.ctx).create(
            this.ctx.user,
            "UPDATE",
            "MOD",
            {
                ...Object.keys(updateMod)
                    .map(k => ({ [k]: existing[k] }))
                    .reduce((acc, cur, i) => ({ ...acc, ...cur }), {})
            },
            updateMod
        );
        if (Object.keys(updateMod).indexOf("status") !== -1 && !isInsert) {
            const newStatus = updateMod.status;
            new DiscordManager().sendWebhook(`${this.ctx.user.username} ${newStatus} ${existing.name} v${existing.version}`, [], "https://beatmods.com");
            // } else if (!isInsert) {
            //     new DiscordManager().sendWebhook(
            //         `${this.ctx.user.username} updated ${existing.name} v${existing.version}`,
            //         Object.keys(updateMod)
            //             .filter(i => i !== "updatedDate" && i !== "dependencies")
            //             .map(i => ({ name: i, value: updateMod[i] })) as dynamic[],
            //         "https://beatmods.com"
            //     );
        }
        return (await this.dao.update(toId(mod._id), updateMod)) as IDbMod;
    }

    public async create(
        user: ISessionUser,
        name: string,
        description: string,
        version: string,
        dependencies: string,
        category: string,
        link: string,
        files: Express.Multer.File[]
    ) {
        const existing = await this.find({ name, version });
        if (existing) {
            throw new ParameterError("mod.duplicate_upload");
        }
        if (files) {
            const _dependencies = await this.dao.getDependencies(dependencies);
            const mod: IDbMod = {
                name,
                description: description || "",
                authorId: toId(user._id),
                version,
                link,
                updatedDate: new Date(),
                uploadDate: new Date(),
                status: "pending",
                downloads: [],
                category: category || "Uncategorized",
                required: false,
                dependencies: _dependencies.map(m => m._id)
            };
            const { _id } = (await this.insert(mod)) as IDbMod & { _id: Id };
            mod._id = toId(_id);
            try {
                privkey = await new Promise((res, rej) => {
                    fs.readFile(path.join(process.cwd(), "/keys/privkey.asc"), "utf-8", (err, data) => {
                        if (err) {
                            rej(err);
                        }
                        openpgp.key.readArmored(data).then(output => {
                            res(output.keys[0]);
                        });
                    });
                });
                await privkey.decrypt(process.env.PASSPHRASE);
            } catch (err) {
                console.error("ModService.create", "KEY Read", err);
                throw new ServerError("mod.upload.key.read");
            }
            let index = 0;
            for (const file of files) {
                const type = files.length === 1 ? "universal" : index === 0 ? "steam" : "oculus";
                const filePath = `/uploads/${_id.toString()}/${type}/`;
                const fileName = `${name}-${version}.zip`;
                const fullPath = path.join(process.cwd(), filePath);
                const fullFile = path.join(fullPath, fileName);
                const fullSigFile = `${fullFile}.sig`;
                try {
                    await new Promise((res, rej) => {
                        const mkdir = (dirPath: string, root = "") => {
                            const dirs = dirPath.split(path.sep);
                            const dir = dirs.shift();
                            root = (root || "") + dir + path.sep;

                            try {
                                fs.mkdirSync(root);
                            } catch (e) {
                                if (!fs.statSync(root).isDirectory()) {
                                    throw new Error(e);
                                }
                            }

                            return !dirs.length || mkdir(dirs.join(path.sep), root);
                        };
                        mkdir(fullPath);
                        fs.writeFile(fullFile, file.buffer, { flag: "w" }, () => {
                            res();
                        });
                    });
                } catch (err) {
                    console.error("ModService.create", "ZIP Write", err);
                    throw new ServerError("mod.upload.zip.create");
                }
                try {
                    const md5Hashes: { hash: string; file: string }[] = [];
                    await new Promise((res, rej) => {
                        const zip = new StreamZip({
                            file: fullFile,
                            storeEntries: true
                        });
                        zip.on("ready", () => {
                            for (const entry of Object.values(zip.entries()) as any[]) {
                                if (entry.isDirectory) {
                                    continue;
                                }
                                try {
                                    const data = zip.entryDataSync(entry);
                                    const hash = md5(data);
                                    md5Hashes.push({ hash, file: entry.name });
                                } catch (error) {
                                    return rej(entry.name + " -- " + error);
                                }
                            }
                            zip.close();
                            res();
                        });
                    });
                    if (mod.downloads) {
                        mod.downloads.push({ type, url: path.join(filePath, fileName), hashMd5: md5Hashes });
                    }
                } catch (error) {
                    console.error("ModService.create zip.read", error);
                    throw new ServerError("mod.upload.zip.corrupt");
                }
                try {
                    await new Promise((res, rej) => {
                        const signOptions = {
                            message: openpgp.message.fromBinary(fs.createReadStream(fullFile)),
                            privateKeys: [privkey],
                            detached: true,
                            streaming: "node"
                        };
                        openpgp.sign(signOptions).then(signed => {
                            signed.signature.pipe(fs.createWriteStream(fullSigFile));
                            openpgp.stream.readToEnd(signOptions.message.armor()).catch(err => rej(err));
                            res();
                        });
                    });
                } catch (err) {
                    console.error("ModService.create", "SIG Create", err);
                    throw new ServerError("mod.upload.sig.create");
                }
                index++;
            }
            if (mod.downloads && !mod.downloads.length) {
                console.error("ModService.create download empty");
                await this.remove(toId(mod._id));
                throw new ServerError("mod.upload.zip.unknown");
            }
            await this.update(mod, true);
        }
        return true;
    }
}
