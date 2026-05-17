package com.dolby.instoredemoapp;

/* JADX INFO: loaded from: classes.dex */
public class TextInfo {
    public String text;
    public String textColor;
    public String textFont;
    public String textPos;

    public TextInfo() {
        this.text = "";
        this.textColor = "unset";
        this.textFont = "unset";
        this.textPos = "unset";
    }

    public TextInfo(String txt, String color, String font, String pos) {
        this.text = txt;
        this.textColor = color;
        this.textFont = font;
        this.textPos = pos;
    }

    public String toString() {
        String str = "TextInfo:\n    text = " + this.text + "\n    textColor = " + this.textColor + "\n    font = " + this.textFont + "\n    position = " + this.textPos + "\n";
        return str;
    }
}
