mod model;

pub use model::{
    build_conflict_analysis_input, build_duplicate_request, conflict_case_matches_scope,
    parse_conflict_analysis_response, parse_duplicate_response, AnalyzeConflictScope,
    ConflictAnalysis, ConflictAnalysisAction, ConflictAnalysisInput, ConflictAnalysisRecord,
    ConflictCaseAnalysis, CoverageRelation, DuplicateAnalysis, DuplicateAnalysisSource,
    DuplicateCandidate, DuplicateRelation, RetentionRecommendation, CONFLICT_ANALYSIS_MAX_CASES,
};
