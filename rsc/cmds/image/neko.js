'use strict';

const { Command } = require("../../classes/Command");
const expressCmd = require("../../rsc/expressCmd");

module.exports = class nekoCmd extends Command {
    constructor(interaction) {
        super(interaction, {
            name: "neko"
        });
    }

    async run(inter) {
        return expressCmd(inter, "nekos", " nyaa~");
    }
}