// Static string -> reference -> function evidence. Pseudocode stays in the caller's local output.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Reference;
import com.google.gson.GsonBuilder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

public class R8BleReport extends GhidraScript {
    private Map<String,Object> reference(Reference ref) {
        Map<String,Object> row = new LinkedHashMap<>();
        row.put("from", ref.getFromAddress().toString());
        row.put("type", ref.getReferenceType().toString());
        Function owner = getFunctionContaining(ref.getFromAddress());
        row.put("function", owner == null ? null : owner.getEntryPoint().toString());
        return row;
    }

    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Supply a new report JSON path");
        Path output = Path.of(args[0]);
        if (Files.exists(output)) throw new IllegalArgumentException("Report already exists");
        Map<String,Object> report = new LinkedHashMap<>();
        report.put("payload_sha256", currentProgram.getExecutableSHA256());
        report.put("language", currentProgram.getLanguageID().toString());
        report.put("image_base", currentProgram.getImageBase().toString());
        report.put("mapped_start", currentProgram.getMinAddress().toString());
        report.put("mapped_end", currentProgram.getMaxAddress().toString());
        report.put("function_count", currentProgram.getFunctionManager().getFunctionCount());
        List<Object> anchors = new ArrayList<>();
        Set<Function> selected = new LinkedHashSet<>();
        for (String label : new String[]{"AEUS", "GPSD", "BTreq", "UMRK", "SPEEDCAM"}) {
            byte[] pattern = label.getBytes(StandardCharsets.US_ASCII);
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
        // One bounded call-graph step helps validate a string consumer's helper
        // semantics. Do not expand the whole graph from library/ROM calls.
        for (Function function : new ArrayList<>(selected)) {
            selected.addAll(function.getCalledFunctions(monitor));
        }
        DecompInterface decompiler = new DecompInterface();
        List<Object> functions = new ArrayList<>();
        try {
            if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException("Decompiler could not open program");
            for (Function function : selected) {
                Map<String,Object> row = new LinkedHashMap<>();
                row.put("entry", function.getEntryPoint().toString());
                row.put("name", function.getName());
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
            "Pseudocode is not original source and must not be treated as a proven key/encoder."));
        Files.writeString(output, new GsonBuilder().setPrettyPrinting().create().toJson(report),
            StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.CREATE_NEW);
        println("Saved static BLES report: " + output);
    }
}
