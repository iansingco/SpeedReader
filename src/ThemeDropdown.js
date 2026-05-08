import { useState } from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { MONO } from "./constants";

const OPTIONS = [
  { id: "dark",  icon: "◐", label: "Dark"  },
  { id: "sepia", icon: "☕", label: "Sepia" },
  { id: "light", icon: "○", label: "Light" },
];

// Header height estimate used to position the menu below the header bar.
const MENU_TOP = Platform.OS === "web" ? 54 : 90;

export default function ThemeDropdown({ theme, onChange, t }) {
  const [open, setOpen] = useState(false);
  const active = OPTIONS.find(o => o.id === theme) || OPTIONS[0];

  return (
    <View>
      <TouchableOpacity
        style={[td.trigger, { borderColor: t.muted + "88" }]}
        onPress={() => setOpen(v => !v)}
        activeOpacity={0.7}
      >
        <Text style={{ color: open ? t.accent : t.muted, fontSize: 14 }}>
          {active.icon}
        </Text>
        <Text style={{ color: open ? t.accent : t.muted, fontSize: 9, fontFamily: MONO, marginLeft: 3 }}>
          ▾
        </Text>
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        {/* Full-screen backdrop — tap anywhere outside menu to close */}
        <TouchableOpacity
          style={{ flex: 1 }}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          {/* Menu anchored to top-right */}
          <View
            style={[td.menu, {
              backgroundColor: t.surface,
              borderColor:     t.muted + "44",
              top:             MENU_TOP,
            }]}
            // Stop touches from bubbling to the backdrop
            onStartShouldSetResponder={() => true}
          >
            {OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.id}
                style={[td.item, theme === opt.id && { backgroundColor: t.accent + "22" }]}
                onPress={() => { onChange(opt.id); setOpen(false); }}
                activeOpacity={0.7}
              >
                <Text style={{ fontSize: 15, marginRight: 10 }}>{opt.icon}</Text>
                <Text style={[td.label, { color: theme === opt.id ? t.accent : t.text }]}>
                  {opt.label}
                </Text>
                {theme === opt.id && (
                  <Text style={{ color: t.accent, fontSize: 10, marginLeft: "auto" }}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const td = StyleSheet.create({
  trigger: {
    flexDirection:  "row",
    alignItems:     "center",
    borderWidth:    1,
    borderRadius:   6,
    paddingHorizontal: 10,
    paddingVertical:    6,
  },
  menu: {
    position:    "absolute",
    right:       16,
    minWidth:    130,
    borderWidth: 1,
    borderRadius: 10,
    overflow:    "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius:  10,
    elevation:    10,
  },
  item: {
    flexDirection:  "row",
    alignItems:     "center",
    paddingHorizontal: 16,
    paddingVertical:   12,
  },
  label: { fontFamily: MONO, fontSize: 13, flex: 1 },
});
