// Static string -> reference -> function evidence. Pseudocode stays in the caller's local output.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Reference;
import com.google.gson.GsonBuilder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.security.MessageDigest;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public class R8BleReport extends GhidraScript {
    private Map<String,Object> reference(Reference ref) {
        Map<String,Object> row = new LinkedHashMap<>();
        row.put("from", ref.getFromAddress().toString());
        row.put("type", ref.getReferenceType().toString());
        Function owner = getFunctionContaining(ref.getFromAddress());
        row.put("function", owner == null ? null : owner.getEntryPoint().toString());
        return row;
    }

    private List<Object> incoming(Function function, Set<Function> callers) {
        List<Object> rows = new ArrayList<>();
        // Thumb function pointers can refer to entry+1, while CALL references
        // use the even code address. Preserve both forms as observations.
        for (Address target : new Address[]{function.getEntryPoint(), function.getEntryPoint().add(1)}) {
            for (Reference ref : currentProgram.getReferenceManager().getReferencesTo(target)) {
                rows.add(reference(ref));
                Function owner = getFunctionContaining(ref.getFromAddress());
                if (owner != null && !owner.equals(function)) callers.add(owner);
            }
        }
        return rows;
    }

    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) throw new IllegalArgumentException("Supply a new report JSON path, optionally followed by function addresses");
        Path output = Path.of(args[0]);
        if (Files.exists(output)) throw new IllegalArgumentException("Report already exists");
        Map<String,Object> report = new LinkedHashMap<>();
        report.put("payload_sha256", currentProgram.getExecutableSHA256());
        report.put("language", currentProgram.getLanguageID().toString());
        report.put("image_base", currentProgram.getImageBase().toString());
        report.put("mapped_start", currentProgram.getMinAddress().toString());
        report.put("mapped_end", currentProgram.getMaxAddress().toString());
        report.put("function_count", currentProgram.getFunctionManager().getFunctionCount());
        int extent = (int)(currentProgram.getMaxAddress().subtract(currentProgram.getMinAddress())+1);
        if (extent < 1 || extent > 65536) throw new IllegalArgumentException("Unexpected BLES mapped extent");
        byte[] mapped = new byte[extent];
        if (currentProgram.getMemory().getBytes(currentProgram.getMinAddress(), mapped) != extent) {
            throw new IllegalArgumentException("BLES mapping is not contiguous");
        }
        String mappedHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(mapped));
        report.put("mapped_bytes_sha256", mappedHash);
        report.put("bytes_match_input_digest", mappedHash.equals(currentProgram.getExecutableSHA256()));
        ghidra.framework.options.Options modelOptions = currentProgram.getOptions("R8 BLE ROM model");
        if (modelOptions.contains("assumed_rom_helper")) {
            Map<String,Object> model = new LinkedHashMap<>();
            model.put("completed", modelOptions.getBoolean("completed", false));
            model.put("assumed_rom_helper", modelOptions.getString("assumed_rom_helper", ""));
            model.put("assumed_abi", modelOptions.getString("assumed_abi", ""));
            model.put("assumed_constant_inline_tables", modelOptions.getBoolean("assumed_constant_inline_tables", false));
            model.put("modeled_inline_tables", modelOptions.getInt("modeled_inline_tables", 0));
            report.put("rom_model_assumptions", model);
        }
        List<Object> anchors = new ArrayList<>();
        Set<Function> selected = new LinkedHashSet<>();
        Map<String,byte[]> patterns = new LinkedHashMap<>();
        for (String label : new String[]{"AEUS", "GPSD", "BTreq", "UMRK", "SPEEDCAM",
                                        "BTdnSTART", "BTdnGDSTR", "BTdnGDEND", "BTdnFLSWR", "BTdnFINIS"}) {
            patterns.put(label, label.getBytes(StandardCharsets.US_ASCII));
        }
        List<String> pointerQueries = new ArrayList<>();
        for (int i = 1; i < args.length; i++) {
            if (args[i].startsWith("ptr:")) {
                long value = Long.decode(args[i].substring(4));
                if (value < 0 || value > 0xffffffffL) throw new IllegalArgumentException("Pointer must be uint32");
                patterns.put(args[i], ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt((int)value).array());
                pointerQueries.add(args[i]);
            }
        }
        for (Map.Entry<String,byte[]> patternEntry : patterns.entrySet()) {
            String label = patternEntry.getKey();
            byte[] pattern = patternEntry.getValue();
            Address start = currentProgram.getMinAddress();
            while (start != null && start.compareTo(currentProgram.getMaxAddress()) <= 0) {
                Address anchor = currentProgram.getMemory().findBytes(start, pattern, null, true, monitor);
                if (anchor == null) break;
                Map<String,Object> row = new LinkedHashMap<>();
                row.put("label", label);
                row.put("address", anchor.toString());
                row.put("file_offset", anchor.getOffset()-currentProgram.getMinAddress().getOffset());
                List<Object> refs = new ArrayList<>();
                for (Reference ref : currentProgram.getReferenceManager().getReferencesTo(anchor)) {
                    Map<String,Object> r = reference(ref);
                    Function owner = getFunctionContaining(ref.getFromAddress());
                    if (owner != null) selected.add(owner);
                    // A literal pool/pointer reference often has no containing function.
                    List<Object> indirect = new ArrayList<>();
                    for (Reference second : currentProgram.getReferenceManager().getReferencesTo(ref.getFromAddress())) {
                        indirect.add(reference(second));
                        Function caller = getFunctionContaining(second.getFromAddress());
                        if (caller != null) selected.add(caller);
                    }
                    r.put("references_to_reference_location", indirect);
                    refs.add(r);
                }
                row.put("references", refs);
                anchors.add(row);
                start = anchor.add(1);
            }
        }
        report.put("anchors", anchors);
        List<String> seededEntries = new ArrayList<>();
        List<String> explicitEntries = new ArrayList<>();
        for (int i = 1; i < args.length; i++) {
            if (args[i].startsWith("ptr:")) continue;
            explicitEntries.add(args[i]);
            Address entry = toAddr(Long.decode(args[i]));
            if (!currentProgram.getMemory().contains(entry)) {
                throw new IllegalArgumentException("Address is outside mapped payload: " + args[i]);
            }
            Function function = getFunctionAt(entry);
            if (function == null) {
                if (getFunctionContaining(entry) != null) {
                    throw new IllegalArgumentException("Address is inside an existing function, not its entry: " + args[i]);
                }
                disassemble(entry);
                function = createFunction(entry, "trace_selected_" + entry);
                if (function == null) throw new IllegalArgumentException("Cannot seed function: " + args[i]);
                seededEntries.add(entry.toString());
            }
            selected.add(function);
        }
        report.put("explicit_function_entries", explicitEntries);
        report.put("explicit_pointer_queries", pointerQueries);
        report.put("user_seeded_function_entries", seededEntries);
        Set<Function> callers = new LinkedHashSet<>();
        for (Function function : new ArrayList<>(selected)) incoming(function, callers);
        selected.addAll(callers);
        // One bounded incoming step, then one outgoing step. Explicit addresses
        // permit adaptive follow-up without an unbounded whole-program trace.
        for (Function function : new ArrayList<>(selected)) {
            for (Function called : function.getCalledFunctions(monitor)) {
                if (currentProgram.getMemory().contains(called.getEntryPoint())) selected.add(called);
            }
        }
        DecompInterface decompiler = new DecompInterface();
        DecompileOptions options = new DecompileOptions();
        options.setRespectReadOnly(true);
        decompiler.setOptions(options);
        List<Object> functions = new ArrayList<>();
        try {
            if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException("Decompiler could not open program");
            for (Function function : selected) {
                Map<String,Object> row = new LinkedHashMap<>();
                row.put("entry", function.getEntryPoint().toString());
                row.put("name", function.getName());
                row.put("body_address_count", function.getBody().getNumAddresses());
                row.put("body_ranges", function.getBody().toString());
                row.put("incoming_references", incoming(function, new LinkedHashSet<>()));
                DecompileResults result = decompiler.decompileFunction(function, 30, monitor);
                row.put("completed", result.decompileCompleted());
                row.put("error", result.getErrorMessage());
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) {
                    row.put("pseudocode", result.getDecompiledFunction().getC());
                }
                List<String> calls = new ArrayList<>();
                for (Function called : function.getCalledFunctions(monitor)) calls.add(called.getEntryPoint().toString());
                Collections.sort(calls);
                row.put("calls", calls);
                functions.add(row);
            }
        } finally { decompiler.dispose(); }
        report.put("selected_functions", functions);
        report.put("limitations", List.of("Static analysis; no target execution or observed detector behavior.",
            "Automatic analysis may miss indirect references or misidentify functions.",
            "Unmapped call fixups and constant-table annotations are analysis assumptions, not observed ROM code.",
            "Pseudocode is not original source and must not be treated as a proven key/encoder."));
        Files.writeString(output, new GsonBuilder().setPrettyPrinting().create().toJson(report),
            StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.CREATE_NEW);
        println("Saved static BLES report: " + output);
    }
}
