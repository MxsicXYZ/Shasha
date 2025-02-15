'use strict';

const { Command } = require("../../classes/Command");

module.exports = class ReloadCmd extends Command {
    constructor(interaction) {
        super(interaction, {
            name: "reload",
            ownerOnly: true
        });
    }

    async run(inter) {
        await inter.deferReply();
        try {
            inter.client.dispatch();
        } catch (e) {
            console.error(e);
            await inter.editReply("```js\n" + e.stack + "\nexiting...```");
            process.exit(1);
        }
        return inter.editReply("Okkiie thank chu ❤️❤️");
    }
}