///<reference path='../../editor/messages.ts'/>

var Blockly: any;

module TDev {

    // ---------- Communication protocol

    var allowedOrigins = {
        "http://localhost:4242": null,
        "http://www.touchdevelop.com": null,
    };

    // Both of these are written once when we receive the first (trusted)
    // message.
    var outer: Window = null;
    var origin: string = null;

    // Also written once at initialization-time.
    var editor = null;

    // A global that remembers the current version we're editing
    var currentVersion: string;

    window.addEventListener("message", (event) => {
        if (!(event.origin in allowedOrigins))
            return;

        if (!outer || !origin) {
            outer = event.source;
            origin = event.origin;
        }

        receive(<External.Message>event.data);
    });

    function receive(message: External.Message) {
        console.log("[inner message]", message);

        switch (message.type) {
            case External.MessageType.Init:
                setupEditor(<External.Message_Init> message);
                setupButtons();
                setupCurrentVersion(<External.Message_Init> message);
                break;

            case External.MessageType.SaveAck:
                saveAck(<External.Message_SaveAck> message);
                break;

            case External.MessageType.Merge:
                promptMerge((<External.Message_Merge> message).merge);
                break;
        }
    }

    function post(message: External.Message) {
        if (!outer)
            console.error("Invalid state");
        outer.postMessage(message, origin);
    }

    // ---------- Revisions

    function prefix(where: External.SaveLocation) {
        switch (where) {
            case External.SaveLocation.Cloud:
                return("☁  [cloud]");
            case External.SaveLocation.Local:
                return("⌂ [local]");
        }
    }

    function saveAck(message: External.Message_SaveAck) {
        switch (message.status) {
            case External.Status.Error:
                statusMsg(prefix(message.where)+" error: "+message.error, message.status);
                break;
            case External.Status.Ok:
                if (message.where == External.SaveLocation.Cloud) {
                    statusMsg(prefix(message.where)+" successfully saved "+
                        "(from "+currentVersion+" to "+message.newBaseSnapshot+")", message.status);
                    currentVersion = message.newBaseSnapshot;
                } else {
                    statusMsg(prefix(message.where)+" successfully saved", message.status);
                }
                break;
        }
    }

    function promptMerge(merge: External.PendingMerge) {
        console.log("[merge] merge request, base = "+merge.base.baseSnapshot +
            ", theirs = "+merge.theirs.baseSnapshot +
            ", mine = "+currentVersion);
        var mkButton = function (symbol: string, label: string, f: () => void) {
            var b = document.createElement("a");
            b.classList.add("roundbutton");
            b.setAttribute("href", "#");
            var s = document.createElement("div");
            s.classList.add("roundsymbol");
            s.textContent = symbol;
            b.appendChild(s);
            var l = document.createElement("div");
            l.classList.add("roundlabel");
            l.textContent = label;
            b.appendChild(l);
            b.addEventListener("click", f);
            return b;
        };
        var box = document.querySelector("#merge-commands");
        var clearMerge = () => {
            while (box.firstChild)
                box.removeChild(box.firstChild);
        };
        var mineText = saveBlockly();
        var mineButton = mkButton("🔍", "see mine", () => loadBlockly(mineText));
        var theirsButton = mkButton("🔍", "see theirs", () => loadBlockly(merge.theirs.scriptText));
        var baseButton = mkButton("🔍", "see base", () => loadBlockly(merge.base.scriptText));
        var mergeButton = mkButton("👍", "finish merge", () => {
            currentVersion = merge.theirs.baseSnapshot;
            clearMerge();
            doSave();
        });
        clearMerge();
        [ mineButton, theirsButton, baseButton, mergeButton ].forEach(button => {
            box.appendChild(button);
            box.appendChild(document.createTextNode(" "));
        });
    }

    function setupCurrentVersion(message: External.Message_Init) {
        currentVersion = message.script.baseSnapshot;
        console.log("[revisions] current version is "+currentVersion);

        if (message.merge)
            promptMerge(message.merge);
    }

    // ---------- UI functions

    interface EditorState {
        lastSave: Date;
    }

    function statusMsg(s: string, st: External.Status) {
        var box = <HTMLElement> document.querySelector("#log");
        var elt = document.createElement("div");
        elt.classList.add("status");
        if (st == External.Status.Error)
            elt.classList.add("error");
        else
            elt.classList.remove("error");
        elt.textContent = s;
        box.appendChild(elt);
        box.scrollTop = box.scrollHeight;
    }

    function loadEditorState(s: string): EditorState {
        return JSON.parse(s || "{ \"lastSave\": null }");
    }

    function saveEditorState(s: EditorState): string {
        return JSON.stringify(s);
    }

    function loadBlockly(s: string) {
        var text = s || "<xml></xml>";
        var xml = Blockly.Xml.textToDom(text);
        Blockly.mainWorkspace.clear();
        try {
            Blockly.Xml.domToWorkspace(Blockly.mainWorkspace, xml);
        } catch (e) {
            console.error("Cannot load saved Blockly script. Too recent?");
            console.error(e);
        }
    }

    function saveBlockly(): string {
        var xml = Blockly.Xml.workspaceToDom(Blockly.mainWorkspace);
        var text = Blockly.Xml.domToPrettyText(xml);
        return text;
    }

    var dirty = false;

    // Called once at startup
    function setupEditor(message: External.Message_Init) {
        var state = loadEditorState(message.script.editorState);

        Blockly.inject(document.querySelector("#editor"), {
            toolbox: document.querySelector("#blockly-toolbox")
        });
        loadBlockly(message.script.scriptText);
        // Hack alert! Blockly's [fireUiEvent] function [setTimeout]'s (with a 0 delay) the actual
        // firing of the event, meaning that the call to [inject] above schedule a change event to
        // be fired immediately after the current function is done. To make sure our change handler
        // does not receive that initial event, we schedule it for slightly later.
        window.setTimeout(() => {
            Blockly.addChangeListener(() => {
                statusMsg("✎ local changes", External.Status.Ok);
                dirty = true;
            });
        }, 1);

        // That's triggered when the user closes or reloads the whole page, but
        // doesn't help if the user hits the "back" button in our UI.
        window.addEventListener("beforeunload", function (e) {
            if (dirty) {
                var confirmationMessage = "Some of your changes have not been saved. Quit anyway?";
                (e || window.event).returnValue = confirmationMessage;
                return confirmationMessage;
            }
        });

        window.setInterval(() => {
            if (dirty)
                doSave();
        }, 5000);

        console.log("[loaded] cloud version " + message.script.baseSnapshot +
            "(dated from: "+state.lastSave+")");
    }

    function doSave() {
        var text = saveBlockly();
        console.log("[saving] on top of: ", currentVersion);
        post(<External.Message_Save>{
            type: External.MessageType.Save,
            script: {
                scriptText: text,
                editorState: saveEditorState({
                    lastSave: new Date()
                }),
                baseSnapshot: currentVersion,
            },
        });
        dirty = false;
    }

    function setupButtons() {
        document.querySelector("#command-quit").addEventListener("click", () => {
            doSave();
            post({ type: External.MessageType.Quit });
        });
        document.querySelector("#command-save").addEventListener("click", () => {
            doSave();
        });
        document.querySelector("#command-compile").addEventListener("click", () => {
            post({ type: External.MessageType.Compile });
        });
        document.querySelector("#command-run").addEventListener("click", () => {
        });
    }
}

